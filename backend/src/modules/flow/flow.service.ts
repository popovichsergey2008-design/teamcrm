import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AppException } from '../../common/http/app-exception';
import { DbService } from '../../database/db.service';
import { FilesService } from '../files/files.service';
import { NotificationCenter } from '../notifications/center.service';
import { ProjectsRepository } from '../projects/projects.repository';
import { RealtimeService } from '../realtime/realtime.service';
import { TaskCardService } from '../taskcard/taskcard.service';
import { TaskActivityRepository } from '../tasks/task-activity.repository';
import { TasksRepository } from '../tasks/tasks.repository';
import { TasksService } from '../tasks/tasks.service';
import {
  BLOCKER_LABEL, BlockerReason, RULE_ACTIONS, RULE_PRESETS, RULE_TRIGGERS, RuleAction, RuleTrigger, ruleSentence, wouldCycle,
} from './flow-rules';
import { FamilyRow, FlowRepository } from './flow.repository';

type Actor = { userId: string; tenantId: string; role: string };

const clean = (s: unknown, max: number) => String(s ?? '').replace(/\r/g, '').trim().slice(0, max);
const boss = (role: string) => role === 'owner' || role === 'manager';

/**
 * Поток работы на доске (#4798 / #4799): препятствия, связи задач, сдача результата
 * версиями, очередь решений, сохранённые виды, правила и согласование клиентом.
 *
 * Главное ограничение — ничего не делать за человека: не закрывать, не переносить,
 * не архивировать. Всё, что здесь происходит само, — это сообщения.
 */
@Injectable()
export class FlowService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Flow');
  private timer: NodeJS.Timeout | null = null;
  /** До какой записи журнала переходов правила уже посмотрели (в памяти процесса). */
  private lastTransition: string | null = null;
  private dueTick = 0;

  constructor(
    private readonly repo: FlowRepository,
    private readonly db: DbService,
    private readonly tasksRepo: TasksRepository,
    private readonly tasks: TasksService,
    private readonly card: TaskCardService,
    private readonly center: NotificationCenter,
    private readonly activity: TaskActivityRepository,
    private readonly projects: ProjectsRepository,
    private readonly realtime: RealtimeService,
    private readonly files: FilesService,
  ) {}

  onModuleInit(): void {
    // «Можно приступать» — всегда, без настройки правил: это и есть смысл связи (4798 §9).
    this.tasks.onTaskClosed(async (e) => { await this.dependencyDone(e.tenantId, e.taskId, e.title); });
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => { void this.tick(); }, 60_000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ── общее ──

  /** Задача, которую человек видит: та же проверка, что у доски. */
  private async visibleTask(a: Actor, taskId: string) {
    const t = await this.tasksRepo.findById(a.tenantId, taskId);
    if (!t) throw AppException.notFound('Задача не найдена');
    if (!(await this.projects.canSee(a.tenantId, t.project_id, a))) throw AppException.forbidden('Эта задача вам недоступна');
    return t;
  }

  private async touched(tenantId: string, taskId: string): Promise<void> {
    const t = await this.tasksRepo.findById(tenantId, taskId);
    if (t) this.realtime.emit(tenantId, t.project_id, 'task.updated', t as any);
  }

  private async nameOf(tenantId: string, userId: string | null | undefined): Promise<string | null> {
    if (!userId) return null;
    const r = await this.db.one<{ full_name: string }>(`SELECT full_name FROM users WHERE tenant_id = $1 AND id = $2`, [tenantId, userId]);
    return r?.full_name ?? null;
  }

  // ── препятствие (4798 §8, 4799 BOARD04 P1) ──

  async setBlocker(a: Actor, taskId: string, dto: { reason: string; need?: string; helperId?: string | null; nextStep?: string; dueOn?: string | null }) {
    const t = await this.visibleTask(a, taskId);
    const reason = (Object.keys(BLOCKER_LABEL).includes(dto.reason) ? dto.reason : 'other') as BlockerReason;
    const need = clean(dto.need, 500);
    if (!need) throw AppException.validation('Напишите, что нужно, чтобы продолжить');
    const before = await this.repo.openBlocker(a.tenantId, taskId);
    await this.repo.upsertBlocker(a.tenantId, taskId, a.userId, {
      reason, need, helperId: dto.helperId || null, nextStep: clean(dto.nextStep, 500), dueOn: dto.dueOn || null,
    });
    await this.activity.log(a.tenantId, taskId, a.userId, before ? 'blocker_changed' : 'blocked', {
      reason: BLOCKER_LABEL[reason], need, helperId: dto.helperId || null,
    });
    await this.tasksRepo.stampTransition(a.tenantId, taskId, a.userId, 'MANUAL').catch(() => undefined);
    if (dto.helperId && String(dto.helperId) !== String(before?.helper_id ?? '')) {
      await this.center.direct({
        tenantId: a.tenantId, taskId, userIds: [String(dto.helperId)], actorId: a.userId,
        title: `Нужна ваша помощь: #${taskId} ${t.title}`.slice(0, 255),
        body: `Работа остановлена: ${need}`, suffix: `help${Date.now()}`,
      });
    }
    await this.touched(a.tenantId, taskId);
    return this.repo.openBlocker(a.tenantId, taskId);
  }

  async resolveBlocker(a: Actor, taskId: string, note?: string) {
    const t = await this.visibleTask(a, taskId);
    const was = await this.repo.openBlocker(a.tenantId, taskId);
    const done = await this.repo.resolveBlocker(a.tenantId, taskId, a.userId, clean(note, 300) || null);
    if (done || t.is_blocked) {
      await this.activity.log(a.tenantId, taskId, a.userId, 'unblocked', { note: clean(note, 300) || null, need: was?.need ?? null });
      await this.tasksRepo.stampTransition(a.tenantId, taskId, a.userId, 'MANUAL').catch(() => undefined);
      if (t.assignee_id) {
        await this.center.direct({
          tenantId: a.tenantId, taskId, userIds: [t.assignee_id], actorId: a.userId,
          title: `Препятствие снято: #${taskId} ${t.title}`.slice(0, 255),
          body: 'Можно продолжать работу.', suffix: `unb${Date.now()}`,
        });
      }
    }
    await this.touched(a.tenantId, taskId);
    return { ok: true };
  }

  getBlocker(a: Actor, taskId: string) {
    return this.visibleTask(a, taskId).then(() => this.repo.openBlocker(a.tenantId, taskId));
  }

  // ── связи задач (4798 §9, 4799 BOARD04 P2) ──

  async links(a: Actor, taskId: string) {
    await this.visibleTask(a, taskId);
    return this.repo.linksOf(a.tenantId, taskId);
  }

  async addLink(a: Actor, taskId: string, dependsOn: string) {
    const t = await this.visibleTask(a, taskId);
    const d = await this.visibleTask(a, String(dependsOn).replace(/^#/, ''));
    if (String(t.id) === String(d.id)) throw AppException.validation('Задача не может ждать сама себя');
    if (wouldCycle(await this.repo.allLinks(a.tenantId), String(t.id), String(d.id))) {
      throw AppException.conflict(`Нельзя: получится круг — #${d.id} уже ждёт #${t.id} (напрямую или через другие задачи)`, { reason: 'cycle' });
    }
    if (await this.repo.addLink(a.tenantId, String(t.id), String(d.id), a.userId)) {
      await this.activity.log(a.tenantId, String(t.id), a.userId, 'link_added', { dependsOn: String(d.id), title: d.title });
      // уже готова — сказать сразу нечего: связь просто для истории
      if (d.closed_at) await this.db.query(`UPDATE task_links SET notified_at = now() WHERE task_id = $1 AND depends_on_id = $2`, [t.id, d.id]);
    }
    await this.touched(a.tenantId, String(t.id));
    return this.repo.linksOf(a.tenantId, String(t.id));
  }

  async removeLink(a: Actor, taskId: string, dependsOn: string) {
    await this.visibleTask(a, taskId);
    if (await this.repo.removeLink(a.tenantId, taskId, dependsOn)) {
      await this.activity.log(a.tenantId, taskId, a.userId, 'link_removed', { dependsOn });
    }
    await this.touched(a.tenantId, taskId);
    return this.repo.linksOf(a.tenantId, taskId);
  }

  // ── подзадачи (#4846, как в Битрикс24) ──

  /** Родитель и подзадачи. Чужие проекты, которых человек не видит, не показываем. */
  async family(a: Actor, taskId: string) {
    await this.visibleTask(a, taskId);
    const rows = await this.repo.family(a.tenantId, taskId);
    const seen = new Map<string, boolean>();
    const out: FamilyRow[] = [];
    for (const r of rows) {
      if (!seen.has(r.project_id)) seen.set(r.project_id, await this.projects.canSee(a.tenantId, r.project_id, a));
      if (seen.get(r.project_id)) out.push(r);
    }
    return { parent: out.find((r) => r.rel === 'parent') ?? null, children: out.filter((r) => r.rel === 'child') };
  }

  /** Сделать задачу подзадачей другой (или снять родителя: parentId = null). */
  async setParent(a: Actor, taskId: string, parentId: string | null) {
    const t = await this.visibleTask(a, taskId);
    const pid = parentId ? String(parentId).replace(/^#/, '') : null;
    const before = t.parent_task_id ? String(t.parent_task_id) : null;
    if (pid) {
      const p = await this.visibleTask(a, pid);
      if (String(p.id) === String(t.id)) throw AppException.validation('Задача не может быть подзадачей самой себя');
      if ((await this.repo.ancestors(a.tenantId, String(p.id))).includes(String(t.id))) {
        throw AppException.conflict(`Нельзя: #${p.id} сама находится внутри #${t.id} — получится круг`, { reason: 'cycle' });
      }
    }
    if (await this.repo.setParent(a.tenantId, String(t.id), pid)) {
      await this.activity.log(a.tenantId, String(t.id), a.userId, pid ? 'parent_set' : 'parent_removed', { parentId: pid ?? before });
      if (pid) await this.activity.log(a.tenantId, pid, a.userId, 'subtask_added', { taskId: String(t.id), title: t.title });
      if (before && before !== pid) await this.activity.log(a.tenantId, before, a.userId, 'subtask_removed', { taskId: String(t.id), title: t.title });
      await this.touched(a.tenantId, String(t.id));
      for (const id of [pid, before]) if (id) await this.touched(a.tenantId, id);
    }
    return this.family(a, String(t.id));
  }

  /** Закрыли задачу — тем, кто её ждал, «можно приступать» (один раз). */
  private async dependencyDone(tenantId: string, taskId: string, title: string): Promise<void> {
    try {
      for (const d of await this.repo.claimDependents(tenantId, taskId)) {
        if (!d.assignee_id) continue;
        const rest = d.open_left > 0 ? ` Ещё ждём: ${d.open_left}.` : ' Можно приступать.';
        await this.center.direct({
          tenantId, taskId: d.task_id, userIds: [d.assignee_id], actorId: null,
          title: `#${taskId} «${title}» завершена`.slice(0, 255),
          body: `Для задачи #${d.task_id} «${d.title}».${rest}`.slice(0, 500),
          suffix: `dep${taskId}`,
        });
      }
    } catch (e) {
      this.log.warn(`зависимые от ${taskId}: ${(e as Error).message}`);
    }
  }

  // ── сдача результата (4798 §5, 4799 BOARD03) ──

  async submit(a: Actor, taskId: string, dto: {
    done?: string; where?: string; limits?: string; reviewerId?: string | null;
    columnId: string; position?: number; confirmGate?: boolean; noAfterReason?: string;
  }) {
    const t = await this.visibleTask(a, taskId);
    const done = clean(dto.done, 2000);
    const where = clean(dto.where, 1000);
    const limits = clean(dto.limits, 1000);
    // Проверяющего выбирает тот, кому это разрешено: руководитель, владелец, постановщик.
    const mayPick = boss(a.role) || String(t.created_by ?? '') === String(a.userId);
    const reviewerId = mayPick && dto.reviewerId ? String(dto.reviewerId) : null;

    // Повторное нажатие: та же сдача за последние 15 секунд — не вторая версия.
    const last = (await this.repo.handoffs(a.tenantId, taskId))[0];
    const twin = last && String(last.author_id) === String(a.userId) && last.done_text === done && last.where_text === where
      && Date.now() - new Date(last.created_at).getTime() < 15_000;

    // Сначала перенос: он может спросить про чек-лист и снимки — тогда сдача не записывается.
    const moved = String(t.column_id) === String(dto.columnId)
      ? t
      : await this.tasks.move(a.tenantId, taskId, {
        columnId: dto.columnId, position: dto.position ?? 0, confirmGate: dto.confirmGate, noAfterReason: dto.noAfterReason,
      } as any, a.userId);
    if (twin) return { task: moved, handoff: last };

    const h = await this.repo.addHandoff(a.tenantId, taskId, a.userId, { done, where, limits, reviewerId });
    await this.activity.log(a.tenantId, taskId, a.userId, 'handoff_submitted', { version: h.version });
    if (done || where || limits) {
      const lines = [`Сдано на проверку (версия ${h.version})`];
      if (done) lines.push(`Что сделано: ${done}`);
      if (where) lines.push(`Где посмотреть: ${where}`);
      if (limits) lines.push(`Ограничения: ${limits}`);
      await this.card.addComment(a.tenantId, taskId, a.userId, lines.join('\n'), false).catch((e) =>
        this.log.warn(`сдача ${taskId} в обсуждение: ${(e as Error).message}`));
    }
    const reviewer = reviewerId ?? t.reviewer_id ?? null;
    if (reviewer && String(reviewer) !== String(t.created_by ?? '')) {
      await this.center.direct({
        tenantId: a.tenantId, taskId, userIds: [reviewer], actorId: a.userId,
        title: `Ждёт вашей проверки: #${taskId} ${t.title}`.slice(0, 255),
        body: done || 'Результат сдан на проверку', suffix: `ho${h.version}`, eventKey: 'task.approval',
      });
    }
    await this.touched(a.tenantId, taskId);
    return { task: (await this.tasksRepo.findById(a.tenantId, taskId)) ?? moved, handoff: h };
  }

  async handoffs(a: Actor, taskId: string) {
    await this.visibleTask(a, taskId);
    return this.repo.handoffs(a.tenantId, taskId);
  }

  // ── очередь решений (4798 §4, 4799 BOARD02) ──

  async queue(a: Actor) {
    const rows = await this.repo.reviewQueue(a.tenantId, a.userId, a.role);
    const out = [];
    for (const r of rows) {
      const h = (await this.repo.handoffs(a.tenantId, r.id))[0] ?? null;
      out.push({ ...r, handoff: h ? { version: h.version, done: h.done_text, author: h.author_name, at: h.created_at } : null });
    }
    return out;
  }

  /** Всё для решения по одной задаче: что просили, что сдали, где смотреть, что проверил ИИ. */
  async reviewItem(a: Actor, taskId: string) {
    const t = await this.visibleTask(a, taskId);
    const [handoffs, checklist, files, ai, check, assignee, creator, reviewer] = await Promise.all([
      this.repo.handoffs(a.tenantId, taskId),
      this.repo.checklist(a.tenantId, taskId),
      this.repo.files(a.tenantId, taskId),
      this.repo.lastAiReview(a.tenantId, taskId),
      this.repo.lastCheckReport(a.tenantId, taskId),
      this.nameOf(a.tenantId, t.assignee_id),
      this.nameOf(a.tenantId, t.created_by),
      this.nameOf(a.tenantId, t.reviewer_id ?? t.created_by),
    ]);
    const canDecide = String(t.created_by ?? '') === String(a.userId) || String(t.reviewer_id ?? '') === String(a.userId) || a.role === 'owner';
    return {
      task: {
        id: String(t.id), title: t.title, description: t.description, project_id: t.project_id, column_id: t.column_id,
        deadline_at: (t as any).deadline_at ?? null, submitted_at: t.submitted_at ?? null, first_submitted_at: (t as any).first_submitted_at ?? null,
        returned_at: t.returned_at ?? null, closed_at: t.closed_at, approval_state: t.approval_state,
        assignee_name: assignee, creator_name: creator, reviewer_name: reviewer, version: t.version,
      },
      handoffs, checklist, files,
      ai: ai ? { ...ai.detail, at: ai.created_at } : null,
      check: check ?? null,
      canDecide,
    };
  }

  async decide(a: Actor, taskId: string, dto: { action: 'accept' | 'return' | 'ask'; note?: string; handoffVersion?: number }) {
    const t = await this.visibleTask(a, taskId);
    const note = clean(dto.note, 2000);
    const latest = (await this.repo.handoffs(a.tenantId, taskId))[0] ?? null;

    if (dto.action === 'ask') {
      if (!note) throw AppException.validation('Напишите вопрос');
      const who = await this.nameOf(a.tenantId, t.assignee_id);
      await this.card.addComment(a.tenantId, taskId, a.userId, `${who ? `@${who}, ` : ''}вопрос по результату: ${note}`, false);
      await this.activity.log(a.tenantId, taskId, a.userId, 'review_question', {});
      return { ok: true, action: 'ask' };
    }

    // Уже решено — второй клик и повтор запроса ничего не делают.
    if (t.closed_at) {
      if (dto.action === 'accept') return { ok: true, action: 'accept', already: true };
      throw AppException.conflict('Результат уже принят', { reason: 'decided' });
    }
    // Пришла новая версия, пока человек читал старую, — пусть перечитает.
    if (latest && dto.handoffVersion !== undefined && Number(dto.handoffVersion) < latest.version) {
      throw AppException.conflict('Исполнитель прислал новую версию результата — посмотрите её перед решением', {
        reason: 'new_version', version: latest.version,
      });
    }

    if (dto.action === 'accept') {
      await this.tasks.acceptReview(a.tenantId, taskId, a);
      if (latest) await this.repo.decideHandoff(a.tenantId, taskId, latest.version, a.userId, 'accepted', note || null);
      if (note) await this.card.addComment(a.tenantId, taskId, a.userId, `Результат принят. ${note}`, false).catch(() => undefined);
      return { ok: true, action: 'accept' };
    }
    if (!note) throw AppException.validation('Напишите, что доработать — без комментария вернуть нельзя');
    await this.tasks.returnReview(a.tenantId, taskId, a, note);
    await this.repo.resetDependents(a.tenantId, taskId);
    if (latest) await this.repo.decideHandoff(a.tenantId, taskId, latest.version, a.userId, 'returned', note);
    await this.card.addComment(a.tenantId, taskId, a.userId, `Возвращено на доработку: ${note}`, false).catch(() => undefined);
    return { ok: true, action: 'return' };
  }

  // ── «Нет обновления» (4798 §10) ──

  async requestUpdate(a: Actor, taskId: string) {
    const t = await this.visibleTask(a, taskId);
    if (!t.assignee_id) throw AppException.validation('У задачи нет исполнителя');
    const last = await this.repo.lastUpdateRequest(a.tenantId, taskId);
    if (last && Date.now() - new Date(last).getTime() < 24 * 3600_000) {
      return { ok: true, already: true };
    }
    const who = await this.nameOf(a.tenantId, t.assignee_id);
    await this.card.addComment(a.tenantId, taskId, a.userId,
      `${who ? `@${who}, ` : ''}по задаче давно нет обновления. Уточните, пожалуйста, состояние.`, false);
    await this.activity.log(a.tenantId, taskId, a.userId, 'update_requested', {});
    return { ok: true };
  }

  // ── виды доски (4798 §12, 4799 BOARD06) ──

  async views(a: Actor, projectId: string) {
    if (!(await this.projects.canSee(a.tenantId, projectId, a))) throw AppException.forbidden('Проект вам недоступен');
    return this.repo.views(a.tenantId, projectId, a.userId);
  }

  async createView(a: Actor, projectId: string, dto: { name: string; query: unknown; shared?: boolean }) {
    if (!(await this.projects.canSee(a.tenantId, projectId, a))) throw AppException.forbidden('Проект вам недоступен');
    const name = clean(dto.name, 120);
    if (!name) throw AppException.validation('Назовите вид');
    if (dto.shared && !boss(a.role)) throw AppException.forbidden('Общий вид сохраняют руководитель или владелец');
    const id = await this.repo.createView(a.tenantId, projectId, a.userId, name, dto.query, !!dto.shared);
    return (await this.repo.views(a.tenantId, projectId, a.userId)).find((v) => v.id === id);
  }

  private async ownView(a: Actor, id: string) {
    const v = await this.repo.view(a.tenantId, id);
    if (!v) throw AppException.notFound('Вид не найден');
    const mine = String(v.owner_id) === String(a.userId);
    if (!mine && !(v.shared && boss(a.role))) throw AppException.forbidden('Менять вид может его автор');
    return v;
  }

  async updateView(a: Actor, id: string, dto: { name?: string; query?: unknown; shared?: boolean }) {
    await this.ownView(a, id);
    if (dto.shared && !boss(a.role)) throw AppException.forbidden('Общий вид сохраняют руководитель или владелец');
    await this.repo.updateView(a.tenantId, id, { name: dto.name !== undefined ? clean(dto.name, 120) || undefined : undefined, query: dto.query, shared: dto.shared });
    return this.repo.view(a.tenantId, id);
  }

  async deleteView(a: Actor, id: string) {
    await this.ownView(a, id);
    await this.repo.deleteView(a.tenantId, id);
    return { ok: true };
  }

  // ── порог «в работе» (4798 §14, 4799 BOARD05) ──

  async setWip(a: Actor, projectId: string, limit: number | null) {
    if (a.role === 'client' || !(await this.projects.canSee(a.tenantId, projectId, a))) throw AppException.forbidden('Проект вам недоступен');
    const v = limit === null || limit === undefined ? null : Math.max(1, Math.min(50, Math.round(Number(limit))));
    await this.repo.setWipLimit(a.tenantId, projectId, Number.isFinite(v as number) ? v : null);
    this.realtime.emit(a.tenantId, projectId, 'column.updated', { projectId } as any);
    return { wipLimit: v };
  }

  // ── правила (4798 §18, 4799 BOARD10) ──

  async rules(a: Actor, projectId: string) {
    if (!(await this.projects.canSee(a.tenantId, projectId, a))) throw AppException.forbidden('Проект вам недоступен');
    const [rules, runs] = await Promise.all([this.repo.rules(a.tenantId, projectId), this.repo.ruleRuns(a.tenantId, projectId)]);
    return {
      rules: rules.map((r) => ({ ...r, sentence: ruleSentence(r.trigger as RuleTrigger, r.action as RuleAction) })),
      presets: RULE_PRESETS.map((p) => ({ ...p, sentence: ruleSentence(p.trigger, p.action) })),
      runs,
    };
  }

  private async manageRules(a: Actor, projectId: string) {
    if (a.role === 'client' || !(await this.projects.canSee(a.tenantId, projectId, a))) throw AppException.forbidden('Правила доски вам недоступны');
  }

  async addRule(a: Actor, projectId: string, trigger: string, action: string) {
    await this.manageRules(a, projectId);
    if (!RULE_TRIGGERS.includes(trigger as RuleTrigger) || !RULE_ACTIONS.includes(action as RuleAction)) throw AppException.validation('Такого правила нет');
    await this.repo.addRule(a.tenantId, projectId, trigger, action, a.userId);
    return this.rules(a, projectId);
  }

  async toggleRule(a: Actor, projectId: string, id: string, enabled: boolean) {
    await this.manageRules(a, projectId);
    await this.repo.setRuleEnabled(a.tenantId, projectId, id, enabled);
    return this.rules(a, projectId);
  }

  async deleteRule(a: Actor, projectId: string, id: string) {
    await this.manageRules(a, projectId);
    await this.repo.deleteRule(a.tenantId, projectId, id);
    return this.rules(a, projectId);
  }

  /** Предпросмотр: на каких недавних задачах сработало бы и кому ушло бы. Ничего не меняет. */
  async previewRule(a: Actor, projectId: string, trigger: string, action: string) {
    await this.manageRules(a, projectId);
    if (!RULE_TRIGGERS.includes(trigger as RuleTrigger) || !RULE_ACTIONS.includes(action as RuleAction)) throw AppException.validation('Такого правила нет');
    const examples = await this.repo.previewTasks(a.tenantId, projectId, trigger);
    const out = [];
    for (const e of examples) {
      const to = await this.recipients(a.tenantId, e.id, action as RuleAction);
      const names = [];
      for (const u of to) names.push((await this.nameOf(a.tenantId, u)) ?? '—');
      out.push({ id: e.id, title: e.title, recipients: names });
    }
    return { sentence: ruleSentence(trigger as RuleTrigger, action as RuleAction), examples: out };
  }

  private async recipients(tenantId: string, taskId: string, action: RuleAction): Promise<string[]> {
    const p = await this.repo.people(tenantId, taskId);
    if (!p) return [];
    switch (action) {
      case 'notify_reviewer': return [p.reviewer_id ?? p.created_by].filter(Boolean) as string[];
      case 'notify_creator': return [p.created_by].filter(Boolean) as string[];
      case 'notify_assignee': return [p.assignee_id].filter(Boolean) as string[];
      case 'notify_watchers': return p.watchers ?? [];
      case 'notify_dependents': {
        const rows = await this.db.many<{ assignee_id: string }>(
          `SELECT t.assignee_id::text FROM task_links l JOIN tasks t ON t.id = l.task_id
            WHERE l.depends_on_id = $1 AND t.assignee_id IS NOT NULL AND t.closed_at IS NULL AND t.deleted_at IS NULL`, [taskId]);
        return rows.map((r) => r.assignee_id);
      }
    }
  }

  /** Сработать по событию: одно событие — одно сообщение на правило (event_key). */
  private async fire(tenantId: string, projectId: string, taskId: string, trigger: RuleTrigger, eventKey: string): Promise<void> {
    const rules = await this.repo.enabledRules(tenantId, projectId, trigger);
    if (!rules.length) return;
    const p = await this.repo.people(tenantId, taskId);
    if (!p) return;
    for (const r of rules) {
      const run = await this.repo.claimRun(tenantId, r.id, taskId, eventKey);
      if (!run) continue;
      const to = await this.recipients(tenantId, taskId, r.action as RuleAction);
      const sent = await this.center.direct({
        tenantId, taskId, userIds: to, actorId: null,
        title: `#${taskId} ${p.title}`.slice(0, 255),
        body: `Правило доски: ${ruleSentence(trigger, r.action as RuleAction)}.`,
        suffix: `rule${r.id}:${eventKey}`,
      });
      await this.repo.setRunRecipients(run, sent.length);
    }
  }

  /**
   * Раз в минуту — новые переходы этапов из журнала (ТЗ-32): так правила видят сдачу,
   * возврат и приёмку, каким бы путём задачу ни двигали. Раз в 10 минут — сроки.
   */
  private async tick(): Promise<void> {
    try {
      if (this.lastTransition === null) {
        const r = await this.db.one<{ id: string }>(`SELECT coalesce(max(id), 0)::text AS id FROM task_status_transitions`);
        this.lastTransition = r?.id ?? '0';
        return;
      }
      const rows = await this.db.many<{ id: string; tenant_id: string; project_id: string; task_id: string; from_stage: string; to_stage: string }>(
        `SELECT s.id::text, s.tenant_id::text, s.project_id::text, s.task_id::text, s.from_stage, s.to_stage
           FROM task_status_transitions s
          WHERE s.id > $1::bigint AND s.project_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM board_rules r WHERE r.project_id = s.project_id AND r.enabled)
          ORDER BY s.id LIMIT 500`,
        [this.lastTransition],
      );
      const max = await this.db.one<{ id: string }>(`SELECT coalesce(max(id), 0)::text AS id FROM task_status_transitions`);
      const review = ['testing', 'review', 'approval'];
      for (const s of rows) {
        const key = `t${s.id}`;
        if (review.includes(s.to_stage) && !review.includes(s.from_stage)) await this.fire(s.tenant_id, s.project_id, s.task_id, 'handed_to_review', key);
        if (s.to_stage === 'work' && review.includes(s.from_stage)) await this.fire(s.tenant_id, s.project_id, s.task_id, 'returned', key);
        if (s.to_stage === 'done') {
          await this.fire(s.tenant_id, s.project_id, s.task_id, 'accepted', key);
          await this.fire(s.tenant_id, s.project_id, s.task_id, 'dependency_done', key);
        }
      }
      this.lastTransition = rows.length === 500 ? rows[rows.length - 1].id : (max?.id ?? this.lastTransition);

      if (this.dueTick++ % 10 === 0) {
        for (const d of await this.repo.dueSoon()) {
          await this.fire(d.tenant_id, d.project_id, d.id, 'deadline_soon', `d${d.id}:${new Date(d.deadline_at).toISOString()}`);
        }
      }
    } catch (e) {
      this.log.warn(`правила доски: ${(e as Error).message}`);
    }
  }

  // ── согласование клиентом (4798 §19, 4799 BOARD09) ──

  private async manageShare(a: Actor, taskId: string) {
    const t = await this.visibleTask(a, taskId);
    const own = [t.created_by, t.assignee_id, t.reviewer_id].some((x) => x && String(x) === String(a.userId));
    if (!own && !boss(a.role)) throw AppException.forbidden('Отправить результат клиенту могут постановщик, исполнитель или руководитель');
    return t;
  }

  async shares(a: Actor, taskId: string) {
    await this.visibleTask(a, taskId);
    return this.repo.shares(a.tenantId, taskId);
  }

  async createShare(a: Actor, taskId: string, dto: { summary?: string; result?: string; fileIds?: string[] }) {
    const t = await this.manageShare(a, taskId);
    const result = clean(dto.result, 4000);
    if (!result) throw AppException.validation('Опишите результат для клиента');
    // Только файлы этой задачи: чужой номер файла в ссылку не попадёт.
    const own = new Set((await this.repo.files(a.tenantId, taskId)).map((f) => f.id));
    const fileIds = (dto.fileIds ?? []).map(String).filter((id) => own.has(id)).slice(0, 20);
    const token = randomBytes(24).toString('base64url');
    await this.repo.createShare(a.tenantId, taskId, a.userId, token, { summary: clean(dto.summary, 1000) || t.title, result, fileIds });
    await this.activity.log(a.tenantId, taskId, a.userId, 'client_link', { files: fileIds.length });
    return { token, path: `/r/${token}` };
  }

  async revokeShare(a: Actor, taskId: string, id: string) {
    await this.manageShare(a, taskId);
    if (await this.repo.revokeShare(a.tenantId, taskId, id)) {
      await this.activity.log(a.tenantId, taskId, a.userId, 'client_link_revoked', {});
    }
    return this.repo.shares(a.tenantId, taskId);
  }

  async guestView(token: string) {
    const s = await this.repo.shareByToken(token);
    if (!s) throw AppException.notFound('Ссылка не действует — возможно, её отозвали');
    const files = await this.repo.shareFiles(s.tenant_id, s.task_id, s.file_ids ?? []);
    return {
      title: s.title, summary: s.summary, result: s.result_text, company: s.company, author: s.author_name,
      files: files.map((f) => ({ id: f.id, name: f.name, mime: f.mime })),
      decision: s.decision, decisionNote: s.decision_note, decidedAt: s.decided_at,
    };
  }

  async guestFile(token: string, fileId: string) {
    const s = await this.repo.shareByToken(token);
    if (!s || !(s.file_ids ?? []).map(String).includes(String(fileId))) throw AppException.notFound('Файл не найден');
    return this.files.signPlay(s.tenant_id, String(fileId), 300);
  }

  async guestDecide(token: string, dto: { decision: 'approved' | 'changes'; note?: string; name?: string }) {
    const s = await this.repo.shareByToken(token);
    if (!s) throw AppException.notFound('Ссылка не действует — возможно, её отозвали');
    const note = clean(dto.note, 2000);
    const name = clean(dto.name, 120) || 'Клиент';
    if (dto.decision === 'changes' && !note) throw AppException.validation('Напишите, что изменить');
    if (!(await this.repo.decideShare(s.id, dto.decision, note, name))) {
      throw AppException.conflict('Решение по этой ссылке уже отправлено');
    }
    const text = dto.decision === 'approved'
      ? `${name} согласовал(а) результат по ссылке.${note ? ` Комментарий: ${note}` : ''}`
      : `${name} просит изменения: ${note}`;
    const author = s.created_by;
    if (author) await this.card.addComment(s.tenant_id, s.task_id, author, `Клиент: ${text}`, false).catch(() => undefined);
    await this.activity.log(s.tenant_id, s.task_id, null, 'client_decision', { decision: dto.decision, name, note: note.slice(0, 300) });
    const p = await this.repo.people(s.tenant_id, s.task_id);
    if (p) {
      await this.center.direct({
        tenantId: s.tenant_id, taskId: s.task_id, userIds: [p.created_by, p.assignee_id, author].filter(Boolean) as string[], actorId: null,
        title: dto.decision === 'approved' ? `Клиент согласовал: #${s.task_id} ${s.title}` : `Клиент просит изменения: #${s.task_id} ${s.title}`,
        body: text, suffix: `client${s.id}`,
      });
    }
    await this.touched(s.tenant_id, s.task_id);
    return { ok: true };
  }
}
