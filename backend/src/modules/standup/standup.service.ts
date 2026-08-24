import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { Q_AI_STANDUP, RabbitMQService } from '../../messaging/rabbitmq.service';
import { AiService } from '../ai/ai.service';
import { validateStandupPackage } from '../ai/standup-schema';
import { ProjectsRepository } from '../projects/projects.repository';
import { TasksService } from '../tasks/tasks.service';
import { TasksRepository } from '../tasks/tasks.repository';
import { TimeTrackingRepository } from '../timetracking/timetracking.repository';
import { EconomicsProducer } from '../economics/economics.producer';
import { RealtimeService } from '../realtime/realtime.service';
import { TelegramService } from '../telegram/telegram.service';
import { TelegramSender } from '../telegram/telegram.sender';
import { StandupRepository, SubmissionRow } from './standup.repository';
import { StandupMessage } from './standup.types';

const APPEND = 1_000_000; // позиция «в конец» (без сдвига соседей)

@Injectable()
export class StandupService {
  private readonly logger = new Logger('Standup');

  constructor(
    private readonly repo: StandupRepository,
    private readonly mq: RabbitMQService,
    private readonly ai: AiService,
    private readonly telegram: TelegramService,
    private readonly sender: TelegramSender,
    private readonly tasks: TasksService,
    private readonly tasksRepo: TasksRepository,
    private readonly projects: ProjectsRepository,
    private readonly timelogs: TimeTrackingRepository,
    private readonly economics: EconomicsProducer,
    private readonly realtime: RealtimeService,
  ) {}

  // ---------- webhook ----------

  async handleTelegramUpdate(update: any): Promise<void> {
    if (update?.callback_query) return this.handleCallback(update.callback_query);
    const msg = update?.message;
    if (!msg?.from?.id) return;
    const tgUser = msg.from.id;

    const actor = await this.telegram.resolveActor(tgUser);

    // привязка по коду / отклонение непривязанных
    if (!actor) {
      if (msg.text) {
        const linked = await this.telegram.tryLink(tgUser, msg.text);
        await this.sender.sendMessage(
          tgUser,
          linked ? '✅ Аккаунт привязан. Можно присылать дейлик.' : 'Аккаунт не привязан. Отправьте код привязки из веб-CRM.',
        );
      } else {
        await this.sender.sendMessage(tgUser, 'Аккаунт не привязан. Получите код в веб-CRM и отправьте его сюда.');
      }
      return;
    }

    // привязанный: голос или текстовый дейлик
    const audioRef = msg.voice?.file_id
      ? String(msg.voice.file_id)
      : msg.text
        ? `text:${msg.text}`
        : null;
    if (!audioRef) return;

    const sub = await this.repo.create(actor.tenant_id, actor.user_id, String(msg.message_id), audioRef);
    if (!sub) return; // дедуп по message_id — уже обрабатывали
    await this.enqueue('transcribe', sub.tenant_id, sub.id);
  }

  private async handleCallback(cb: any): Promise<void> {
    const actor = await this.telegram.resolveActor(cb.from?.id);
    if (!actor) return;
    const [action, subId] = String(cb.data ?? '').split(':');
    try {
      if (action === 'confirm') {
        await this.confirm(actor.tenant_id, subId, actor.user_id);
        await this.sender.sendMessage(cb.from.id, '✅ Применяю действия дейлика…');
      } else if (action === 'cancel') {
        await this.undo(actor.tenant_id, subId, actor.user_id).catch(() => undefined);
        await this.sender.sendMessage(cb.from.id, '↩️ Отменено.');
      }
    } catch (e) {
      await this.sender.sendMessage(cb.from.id, `Ошибка: ${(e as Error).message}`);
    }
  }

  enqueue(kind: StandupMessage['kind'], tenantId: string, submissionId: string) {
    return this.mq.publish(Q_AI_STANDUP, {
      kind,
      tenantId,
      submissionId,
      dedupKey: `${submissionId}:${kind}`,
    } as StandupMessage);
  }

  // ---------- pipeline (consumer) ----------

  async handle(msg: StandupMessage): Promise<void> {
    const sub = await this.repo.get(msg.tenantId, msg.submissionId);
    if (!sub) return;
    if (msg.kind === 'transcribe') return this.transcribe(sub);
    if (msg.kind === 'parse') return this.parse(sub);
    if (msg.kind === 'apply') return this.applyAndFinish(sub);
  }

  private async transcribe(sub: SubmissionRow): Promise<void> {
    if (sub.status !== 'received' && sub.status !== 'transcribing') return; // идемпотентность
    await this.repo.update(sub.id, { status: 'transcribing' });
    const transcript = await this.ai.transcribe(sub.tenant_id, sub.audio_file_ref ?? '');
    await this.repo.update(sub.id, { status: 'transcribed', transcript_raw: transcript });
    await this.enqueue('parse', sub.tenant_id, sub.id);
  }

  private async parse(sub: SubmissionRow): Promise<void> {
    if (!['transcribed', 'parsing'].includes(sub.status)) return;
    await this.repo.update(sub.id, { status: 'parsing' });

    const { masked, pkg, errors } = await this.ai.maskAndParse(sub.tenant_id, sub.transcript_raw ?? '');
    if (!pkg) {
      await this.repo.update(sub.id, {
        status: 'parse_failed',
        transcript_masked: masked,
        error_code: 'schema_invalid',
      });
      await this.notifyUser(sub, '🤔 Не удалось распознать действия. Переформулируйте, пожалуйста.');
      this.logger.warn(`parse_failed sub=${sub.id}: ${errors.join('; ')}`);
      return;
    }

    await this.repo.update(sub.id, {
      status: 'parsed',
      transcript_masked: masked,
      parsed_json: pkg as any,
      confidence: pkg.confidence.toFixed(3) as any,
    });

    const auto = (await this.repo.tenantAutoApply(sub.tenant_id))?.standup_auto_apply ?? false;
    const lowConfidence = pkg.confidence < 0.8;
    if (auto && !lowConfidence) {
      await this.enqueue('apply', sub.tenant_id, sub.id);
    } else {
      await this.repo.update(sub.id, { status: 'awaiting_confirmation' });
      await this.sendSummary(sub.id, pkg, sub);
    }
  }

  private async applyAndFinish(sub: SubmissionRow): Promise<void> {
    const fresh = await this.repo.get(sub.tenant_id, sub.id);
    if (!fresh) return;
    if (fresh.status === 'applied') return; // идемпотентность на уровне сабмишена
    if (!['parsed', 'awaiting_confirmation', 'applying'].includes(fresh.status)) return;
    await this.repo.update(fresh.id, { status: 'applying' });

    const projects = await this.applyActions(fresh);

    await this.repo.update(fresh.id, { status: 'applied', applied_at: new Date() });
    for (const projectId of projects) {
      this.realtime.emit(fresh.tenant_id, projectId, 'standup.applied', {
        submissionId: fresh.id,
        userId: fresh.user_id,
      });
    }
    await this.notifyUser(fresh, '✅ Дейлик применён: доска и время обновлены.');
  }

  /** Применение действий ИИ через guarded-пути. LLM-вывод = данные, не команда. */
  private async applyActions(sub: SubmissionRow): Promise<Set<string>> {
    const tenantId = sub.tenant_id;
    const actorUserId = sub.user_id; // актор = ПРИВЯЗАННЫЙ пользователь (employee_id из JSON игнорируется)
    const validated = validateStandupPackage(sub.parsed_json);
    const projects = new Set<string>();
    if (!validated.value) return projects;

    for (let i = 0; i < validated.value.actions.length; i++) {
      const a = validated.value.actions[i];
      const kind = a.status_change ? 'status_change' : a.time_logged_minutes ? 'time_log' : 'blocker';

      const reserved = await this.repo.reserveAction(tenantId, sub.id, i, kind);
      if (!reserved) continue; // уже применено — не задваиваем

      // валидация цели: задача должна принадлежать tenant актора (иначе rejected_foreign)
      const task = await this.tasksRepo.findById(tenantId, a.task_id);
      if (!task) {
        // task_id остаётся NULL (FK на tasks) — попытка фиксируется в detail
        await this.repo.updateAction(sub.id, i, {
          result: 'rejected_foreign',
          taskId: null,
          detail: { attemptedTaskId: a.task_id, reason: 'task not in tenant' },
        });
        continue;
      }
      const projectId = task.project_id;
      projects.add(projectId);
      const detail: any = {};
      let timeLogId: string | null = null;
      let rejectedInvalid = false;

      // 1) перенос по статусу (колонку ищем по «корзине» — работает и на русском, и на английском наборе)
      if (a.status_change) {
        const bucket = ({ DONE: 'done', IN_PROGRESS: 'inprogress', TODO: 'todo' } as const)[a.status_change];
        const col = bucket ? await this.projects.findColumnByBucket(tenantId, projectId, bucket) : null;
        if (!col) {
          rejectedInvalid = true;
          detail.statusError = `no column for ${a.status_change}`;
        } else {
          detail.move = { from: task.column_id, to: col.id };
          await this.tasks.move(tenantId, a.task_id, { columnId: col.id, position: APPEND });
          if (a.status_change === 'DONE') await this.tasksRepo.closeTask(tenantId, a.task_id);
        }
      }

      // 2) начисление времени → через тайм-трекинг Этапа 2 (не пишем себестоимость напрямую)
      if (a.time_logged_minutes) {
        const end = new Date();
        const start = new Date(end.getTime() - a.time_logged_minutes * 60_000);
        const tl = await this.timelogs.createClosed(tenantId, a.task_id, actorUserId, start, end);
        timeLogId = tl.id;
        detail.timeLoggedMinutes = a.time_logged_minutes;
        await this.economics.enqueue({
          kind: 'recompute_task',
          tenantId,
          taskId: a.task_id,
          reason: 'time_log_closed',
          dedupKey: `task:${a.task_id}`,
        });
      }

      // 3) блокер
      if (a.blocker_detected) {
        await this.tasksRepo.setBlocked(tenantId, a.task_id, true);
        await this.repo.raiseBlockerAlert(tenantId, projectId, a.task_id, { text: a.blocker_detected });
        detail.blocker = a.blocker_detected;
        this.realtime.emit(tenantId, projectId, 'task.blocked', {
          id: a.task_id,
          project_id: projectId,
          is_blocked: true,
        });
        this.realtime.emitInternal(tenantId, projectId, 'alert.raised', {
          type: 'task_blocked',
          projectId,
          taskId: a.task_id,
        });
      }

      await this.repo.updateAction(sub.id, i, {
        result: rejectedInvalid ? 'rejected_invalid' : 'applied',
        taskId: a.task_id,
        timeLogId,
        detail,
      });
    }
    return projects;
  }

  // ---------- confirm / undo (REST или кнопки бота) ----------

  async confirm(tenantId: string, submissionId: string, actorUserId: string): Promise<{ status: string }> {
    const sub = await this.repo.get(tenantId, submissionId);
    if (!sub) throw AppException.notFound('Submission not found');
    if (sub.user_id !== actorUserId) throw AppException.forbidden('Not your submission');
    if (sub.status !== 'awaiting_confirmation') throw AppException.conflict(`Cannot confirm in status ${sub.status}`);
    await this.enqueue('apply', tenantId, submissionId);
    return { status: 'applying' };
  }

  async undo(tenantId: string, submissionId: string, actorUserId: string): Promise<{ status: string }> {
    const sub = await this.repo.get(tenantId, submissionId);
    if (!sub) throw AppException.notFound('Submission not found');
    if (sub.user_id !== actorUserId) throw AppException.forbidden('Not your submission');
    if (sub.status !== 'applied') throw AppException.conflict(`Cannot undo in status ${sub.status}`);

    const acts = await this.repo.appliedTimeLogIds(submissionId);
    for (const a of acts) {
      if (a.applied_time_log_id) {
        await this.repo.deleteTimeLog(tenantId, a.applied_time_log_id);
        if (a.task_id) {
          await this.economics.enqueue({
            kind: 'recompute_task',
            tenantId,
            taskId: a.task_id,
            reason: 'time_log_closed',
            dedupKey: `task:${a.task_id}`,
          });
        }
      }
      const d = a.detail ?? {};
      if (d.move?.from && a.task_id) {
        await this.tasks.move(tenantId, a.task_id, { columnId: d.move.from, position: APPEND }).catch(() => undefined);
        await this.tasksRepo.reopenTask(tenantId, a.task_id);
      }
      if (d.blocker && a.task_id) {
        await this.tasksRepo.setBlocked(tenantId, a.task_id, false);
      }
    }
    await this.repo.update(submissionId, { status: 'rejected', error_code: 'undone' });
    return { status: 'rejected' };
  }

  // ---------- helpers ----------

  list(tenantId: string) {
    return this.repo.list(tenantId);
  }

  async detail(tenantId: string, id: string, viewerUserId: string) {
    const sub = await this.repo.get(tenantId, id);
    if (!sub) throw AppException.notFound('Submission not found');
    const actions = await this.repo.actions(id);
    // сырой транскрипт виден только владельцу; остальным — маскированный
    const transcript = sub.user_id === viewerUserId ? sub.transcript_raw : sub.transcript_masked;
    return { ...sub, transcript_raw: transcript, actions };
  }

  private async sendSummary(submissionId: string, pkg: any, sub: SubmissionRow) {
    const lines = pkg.actions.map((a: any) => {
      const bits = [`задача #${a.task_id}`];
      if (a.status_change) bits.push(`→ ${a.status_change}`);
      if (a.time_logged_minutes) bits.push(`+${a.time_logged_minutes} мин`);
      if (a.blocker_detected) bits.push(`⛔ ${a.blocker_detected}`);
      return '• ' + bits.join(' ');
    });
    const text = `Распознанный дейлик:\n${lines.join('\n')}\n\nПрименить?`;
    const markup = {
      inline_keyboard: [[
        { text: '✅ Подтвердить', callback_data: `confirm:${submissionId}` },
        { text: '↩️ Отменить', callback_data: `cancel:${submissionId}` },
      ]],
    };
    await this.sender.sendMessage(sub.user_id, text, markup); // user_id≈chat в привязке (упрощение)
  }

  private async notifyUser(sub: SubmissionRow, text: string) {
    await this.sender.sendMessage(sub.user_id, text);
  }
}
