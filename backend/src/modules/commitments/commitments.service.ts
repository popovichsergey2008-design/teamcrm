import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { localParts } from '../assistant/ping-rules';
import { zonedTime } from '../focus/close-day';
import { PushService } from '../notifications/push.service';
import { TelegramMirror } from '../notifications/telegram-mirror.service';
import { Actor, ProactiveService } from '../proactive/proactive.service';
import { ProactiveRepository } from '../proactive/proactive.repository';
import { ProactiveScheduler } from '../proactive/proactive.scheduler';
import { fingerprint } from '../proactive/proactive-rules';
import type { ProposalRow } from '../proactive/proactive.repository';
import { TasksService } from '../tasks/tasks.service';
import { detectCommitment, DeadlineHint, looksCancelled, looksFulfilled, normalizeAction, similarity } from './commitment-rules';
import { CommitmentRow, CommitmentsRepository, MessageRow } from './commitments.repository';

const dateRu = (d: Date | string, tz: string) => new Date(d).toLocaleString('ru-RU', { timeZone: tz, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

/**
 * Охотник за обещаниями (ТЗ-21, этап 2).
 *
 * Находит «я пришлю смету сегодня» в чатах (включая личные), обсуждениях задач и встречах;
 * если по обещанию уже есть задача — привязывает её, а не плодит вторую (§20). Через срок
 * (или 24 ч без срока) проверяет: задача закрыта? автор прислал файл, ссылку, «отправил»?
 * Нет — мягко напоминает самому обещавшему; молчит дальше — сообщает тому, кто просил (§23–24).
 */
@Injectable()
export class CommitmentsService implements OnModuleInit {
  private readonly log = new Logger('Commitments');

  constructor(
    private readonly repo: CommitmentsRepository,
    private readonly proactive: ProactiveService,
    private readonly proactiveRepo: ProactiveRepository,
    private readonly scheduler: ProactiveScheduler,
    private readonly tasks: TasksService,
    private readonly push: PushService,
    private readonly telegram: TelegramMirror,
  ) {}

  onModuleInit(): void {
    this.proactive.register({ skill: 'commitment', execute: (a, p, action) => this.execute(a, p, action) });
    this.scheduler.add('обещания: поиск', () => this.scanAll());
    this.scheduler.add('обещания: проверка', () => this.checkDue());
  }

  // ───────────────────────── поиск ─────────────────────────

  async scanAll(): Promise<void> {
    for (const t of await this.repo.activeTenants()) {
      const tenantId = String(t.id);
      const settings = await this.proactiveRepo.tenantSettings(tenantId);
      if (!settings.enabled || !settings.commitments) continue;
      await this.scanSource(tenantId, 'chat_messages', settings.commitmentCheckHours).catch((e) => this.log.warn(`чаты ${tenantId}: ${(e as Error).message}`));
      await this.scanSource(tenantId, 'task_comments', settings.commitmentCheckHours).catch((e) => this.log.warn(`задачи ${tenantId}: ${(e as Error).message}`));
      await this.scanMeetings(tenantId, settings.commitmentCheckHours).catch((e) => this.log.warn(`встречи ${tenantId}: ${(e as Error).message}`));
    }
  }

  /** Новые сообщения после курсора; при первом запуске — с текущего места, без истории. */
  async scanSource(tenantId: string, source: 'chat_messages' | 'task_comments', checkHours: number): Promise<number> {
    let cur = await this.repo.cursor(tenantId, source);
    if (!cur) {
      await this.repo.setCursor(tenantId, source, await this.repo.maxId(tenantId, source));
      return 0;
    }
    const rows = source === 'chat_messages' ? await this.repo.chatMessages(tenantId, cur) : await this.repo.taskComments(tenantId, cur);
    let found = 0;
    for (const m of rows) {
      const type = source === 'chat_messages' ? 'chat' : 'task';
      await this.afterMessage(tenantId, type, m);
      if (await this.fromMessage(tenantId, type, m, checkHours)) found++;
      cur = m.id;
    }
    if (rows.length) await this.repo.setCursor(tenantId, source, cur);
    return found;
  }

  /** Новое сообщение закрывает открытые обещания: автор прислал результат или их отменили. */
  private async afterMessage(tenantId: string, type: 'chat' | 'task', m: MessageRow) {
    const open = await this.repo.openIn(tenantId, type, m.container_id);
    for (const c of open) {
      if (new Date(m.created_at).getTime() <= new Date(c.source_at).getTime()) continue;
      if (String(c.speaker_user_id) === String(m.author_id) && looksFulfilled({ body: m.body, hasFile: m.has_file })) {
        await this.close(c, 'fulfilled', 'message');
      } else if (looksCancelled(m.body) && (String(m.author_id) === String(c.assigner_user_id) || String(m.author_id) === String(c.speaker_user_id))) {
        await this.close(c, 'cancelled', null);
      }
    }
  }

  private toAbs(hint: DeadlineHint | null, at: Date, tz: string): Date | null {
    if (!hint) return null;
    if (hint.kind === 'relative') return new Date(at.getTime() + hint.minutes * 60_000);
    return zonedTime(hint.date, hint.time, tz);
  }

  private async fromMessage(tenantId: string, type: 'chat' | 'task', m: MessageRow, checkHours: number): Promise<boolean> {
    const at = new Date(m.created_at);
    const l = localParts(at, m.tz);
    const d = detectCommitment(m.body, { date: l.date, hour: l.hour, minute: l.minute, isoDow: l.dow === 0 ? 7 : l.dow });
    if (!d || d.confidence < 0.7) return false;
    let assigner = m.reply_author_id && m.reply_author_id !== m.author_id ? m.reply_author_id
      : m.prev_author_id && m.prev_author_id !== m.author_id ? m.prev_author_id : null;
    if (!assigner && type === 'chat' && m.kind === 'dm') assigner = await this.repo.dmPeer(m.container_id, m.author_id);
    const deadlineAt = this.toAbs(d.deadline, at, m.tz);
    const linked = await this.findTask(tenantId, m.author_id, d.action, type === 'chat' ? m.id : null);
    const checkAt = deadlineAt ?? new Date(at.getTime() + checkHours * 3600_000);
    const id = await this.repo.insert({
      tenantId, sourceType: type, sourceId: m.container_id, messageIds: [m.id], sourceAt: at, quote: m.body,
      speaker: m.author_id, assigner, projectId: m.project_id, action: d.action, normalized: normalizeAction(d.action),
      deadlineAt, deadlineText: d.deadline?.text ?? null, confidence: d.confidence,
      status: linked ? (linked.closed ? 'fulfilled' : 'tracked') : 'detected', linkedTaskId: linked?.id ?? null, checkAt,
    });
    return !!id;
  }

  async scanMeetings(tenantId: string, checkHours: number): Promise<number> {
    const cur = await this.repo.cursor(tenantId, 'meetings');
    if (!cur) {
      await this.repo.setCursor(tenantId, 'meetings', await this.repo.maxId(tenantId, 'meetings'));
      return 0;
    }
    let found = 0;
    let last = cur;
    for (const mt of await this.repo.meetingsDone(tenantId, cur)) {
      for (const s of await this.repo.segments(mt.id)) {
        const at = new Date(mt.at);
        const l = localParts(at, s.tz);
        const d = detectCommitment(s.text, { date: l.date, hour: l.hour, minute: l.minute, isoDow: l.dow === 0 ? 7 : l.dow });
        if (!d || d.confidence < 0.7) continue;
        const deadlineAt = this.toAbs(d.deadline, at, s.tz);
        const linked = await this.findTask(tenantId, s.speaker_user_id, d.action, null);
        const id = await this.repo.insert({
          tenantId, sourceType: 'meeting', sourceId: mt.id, messageIds: [], sourceAt: at, offsetSec: Number(s.start_sec),
          quote: s.text, speaker: s.speaker_user_id,
          assigner: mt.created_by && mt.created_by !== s.speaker_user_id ? mt.created_by : null,
          projectId: mt.project_id, action: d.action, normalized: normalizeAction(d.action), deadlineAt,
          deadlineText: d.deadline?.text ?? null, confidence: d.confidence,
          status: linked ? (linked.closed ? 'fulfilled' : 'tracked') : 'detected', linkedTaskId: linked?.id ?? null,
          checkAt: deadlineAt ?? new Date(at.getTime() + checkHours * 3600_000),
        });
        if (id) found++;
      }
      last = mt.id;
    }
    if (last !== cur) await this.repo.setCursor(tenantId, 'meetings', last);
    return found;
  }

  /** Задача по обещанию уже есть (§20)? Из этого сообщения — точно; иначе по похожести. */
  private async findTask(tenantId: string, assignee: string, action: string, messageId: string | null) {
    const rows = await this.repo.similarTasks(tenantId, assignee, messageId);
    const exact = rows.find((r) => r.from_message);
    if (exact) return exact;
    return rows.find((r) => similarity(action, r.title) >= 0.6) ?? null;
  }

  // ───────────────────────── проверка ─────────────────────────

  async checkDue(): Promise<void> {
    for (const c of await this.repo.due()) {
      try { await this.check(c); } catch (e) { this.log.warn(`обещание ${c.id}: ${(e as Error).message}`); }
    }
  }

  private async check(c: CommitmentRow) {
    const settings = await this.proactiveRepo.tenantSettings(String(c.tenant_id));
    if (c.linked_task_id && (await this.repo.taskClosed(String(c.linked_task_id)))) return this.close(c, 'fulfilled', 'task');
    if (c.status === 'tracked') {
      // задача есть и открыта — обещание живёт её жизнью; заглянем ещё раз через сутки
      return this.repo.update(String(c.id), { check_at: new Date(Date.now() + 24 * 3600_000) });
    }
    if (c.status === 'detected') {
      await this.proposeTo(c, String(c.speaker_user_id), 'self');
      return this.repo.update(String(c.id), {
        status: 'needs_followup', reminded_at: new Date(), remind_count: (c.remind_count ?? 0) + 1,
        check_at: new Date(Date.now() + settings.commitmentEscalateHours * 3600_000),
      });
    }
    // needs_followup: обещавший промолчал — сообщаем тому, кто просил (§24), один раз
    if (!c.escalated_at && c.assigner_user_id && String(c.assigner_user_id) !== String(c.speaker_user_id)) {
      await this.proposeTo(c, String(c.assigner_user_id), 'assigner');
      return this.repo.update(String(c.id), { escalated_at: new Date(), check_at: new Date(Date.now() + 7 * 24 * 3600_000) });
    }
    // дальше не дёргаем: карточки в ящиках остаются, пока их не решат
    return this.repo.update(String(c.id), { check_at: new Date(Date.now() + 30 * 24 * 3600_000) });
  }

  private sourceOf(c: CommitmentRow): { label: string; link: string } {
    const title = c.source_title ? `«${c.source_title}»` : '';
    if (c.source_type === 'chat') return { label: `Чат ${title}`.trim(), link: `/chat/${c.source_id}` };
    if (c.source_type === 'task') return { label: `Задача ${title}`.trim(), link: c.project_id ? `/projects/${c.project_id}/task/${c.source_id}` : '/tasks' };
    const t = c.source_offset_sec != null ? `?t=${Math.floor(Number(c.source_offset_sec))}` : '';
    return { label: `Встреча ${title}`.trim(), link: `/meetings/${c.source_id}${t}` };
  }

  /** Карточка в ящик: обещавшему — мягко, тому, кто просил, — с «напомнить» (§22–23). */
  private async proposeTo(c: CommitmentRow, userId: string, role: 'self' | 'assigner') {
    const tz = await this.proactiveRepo.timezoneOf(String(c.tenant_id), userId);
    const src = this.sourceOf(c);
    const when = dateRu(c.source_at, tz);
    const overdue = c.deadline_at && new Date(c.deadline_at).getTime() < Date.now();
    const waited = overdue ? `Срок «${c.deadline_text}» прошёл` : 'Прошли сутки';
    const noTask = c.linked_task_id ? '' : ' Задачи по этому обещанию в QEVO нет.';
    const self = role === 'self';
    const actions = [
      ...(c.linked_task_id ? [] : [{ key: 'create_task', label: 'Создать задачу', risk: 'high_write', primary: true }]),
      ...(self ? [] : [{ key: 'remind', label: `Напомнить ${c.speaker_name?.split(' ')[0] ?? ''}`.trim(), risk: 'low_write' }]),
      { key: 'done', label: 'Уже выполнено', risk: 'low_write' },
      { key: 'untrack', label: 'Не отслеживать', risk: 'low_write' },
    ];
    await this.proactive.propose({
      tenantId: String(c.tenant_id), userId, skill: 'commitment',
      kind: `${c.source_type}:${c.source_id}`,
      sourceType: c.source_type, sourceId: String(c.source_id), sourceAt: c.source_at,
      sourceLabel: `${src.label}, ${when}`, sourceLink: src.link,
      title: self ? `Вы обещали: ${c.action_text}` : `${c.speaker_name} обещал(а): ${c.action_text}`,
      summary: `«${c.quote.slice(0, 280)}»`,
      why: `${waited}.${noTask} Результата в переписке не видно.`,
      recommend: self ? 'Отметьте, если уже сделано, или поставьте задачу — так обещание не потеряется.'
        : 'Поставьте задачу или напомните — сам обещавший пока не отреагировал.',
      effect: self ? 'Задача появится на вас со сроком из обещания и ссылкой на разговор.'
        : `Задача появится на ${c.speaker_name} со сроком из обещания; «Напомнить» — личное уведомление ему.`,
      priority: overdue ? 1 : 2,
      confidence: Number(c.confidence),
      actions,
      payload: { commitmentId: String(c.id), dueAt: c.deadline_at, role },
      fingerprint: fingerprint({ skill: 'commitment', sourceType: 'commitment', sourceId: String(c.id), entity: role }),
      expiresAt: new Date(Date.now() + 14 * 24 * 3600_000),
    });
  }

  private async close(c: CommitmentRow, status: 'fulfilled' | 'cancelled' | 'dismissed', by: string | null) {
    await this.repo.update(String(c.id), status === 'fulfilled'
      ? { status, fulfilled_at: new Date(), fulfilled_by: by ?? 'user' }
      : status === 'cancelled' ? { status, cancelled_at: new Date() } : { status });
    const text = status === 'fulfilled' ? (by === 'task' ? 'Задача закрыта — обещание выполнено' : 'Обещание выполнено') : 'Обещание снято';
    await this.proactive.resolveBySource(String(c.tenant_id), 'commitment', c.source_type, String(c.source_id), text).catch(() => undefined);
  }

  // ───────────────────────── кнопки карточки ─────────────────────────

  private async execute(a: Actor, p: ProposalRow, action: string) {
    const c = await this.repo.get(a.tenantId, String(p.payload.commitmentId));
    if (!c) throw AppException.notFound('Обещание не найдено');
    const isParty = [c.speaker_user_id, c.assigner_user_id].map(String).includes(String(a.userId));
    if (!isParty) throw AppException.forbidden('Это обещание касается других людей');
    if (action === 'done') {
      await this.close(c, 'fulfilled', 'user');
      return { text: 'Отмечено выполненным' };
    }
    if (action === 'untrack') {
      await this.close(c, 'dismissed', null);
      return { text: 'Больше не отслеживаю это обещание' };
    }
    if (action === 'remind') {
      const author = await this.proactiveRepo.timezoneOf(a.tenantId, String(c.speaker_user_id));
      const src = this.sourceOf(c);
      const text = `Напоминание: вы обещали «${c.action_text}» (${src.label}, ${dateRu(c.source_at, author)}).`;
      await this.push.personal({ tenantId: a.tenantId, userId: String(c.speaker_user_id), eventKey: 'assistant.commitment', title: 'Вы обещали', body: text, path: src.link });
      await this.telegram.push(a.tenantId, String(c.speaker_user_id), text).catch(() => false);
      await this.repo.update(String(c.id), { reminded_at: new Date(), remind_count: (c.remind_count ?? 0) + 1 });
      return { text: `Напомнил: ${c.speaker_name}` };
    }
    if (action === 'create_task') {
      if (c.linked_task_id) return { text: `Задача #${c.linked_task_id} уже есть` };
      const projectId = c.project_id ? String(c.project_id) : await this.repo.defaultProject(a.tenantId);
      if (!projectId) throw AppException.conflict('Нет проекта, куда поставить задачу');
      const src = this.sourceOf(c);
      const task = await this.tasks.create(a.tenantId, {
        projectId,
        title: c.action_text.charAt(0).toUpperCase() + c.action_text.slice(1),
        description: `Обещание из разговора (${src.label}):\n«${c.quote.slice(0, 1500)}»`,
        assigneeId: String(c.speaker_user_id),
        deadlineAt: c.deadline_at ? new Date(c.deadline_at).toISOString() : undefined,
      } as any, a.userId, { sourceChatMessageId: c.source_type === 'chat' && c.source_message_ids?.[0] ? String(c.source_message_ids[0]) : null });
      await this.repo.update(String(c.id), {
        status: 'tracked', linked_task_id: String(task.id),
        check_at: c.deadline_at && new Date(c.deadline_at).getTime() > Date.now() ? new Date(c.deadline_at) : new Date(Date.now() + 24 * 3600_000),
      });
      return { text: `Задача #${task.id} поставлена на ${c.speaker_name}`, link: `/projects/${task.project_id}/task/${task.id}` };
    }
    throw AppException.validation('Такого действия нет');
  }

  // ───────────────────────── экран «Обещания» ─────────────────────────

  async list(a: Actor) {
    const rows = await this.repo.forUser(a.tenantId, a.userId);
    return rows.map((c) => {
      const src = this.sourceOf(c);
      return {
        id: String(c.id), action: c.action_text, quote: c.quote.slice(0, 300), status: c.status,
        mine: String(c.speaker_user_id) === String(a.userId),
        speaker: c.speaker_name, assigner: c.assigner_name ?? null,
        deadlineAt: c.deadline_at, deadlineText: c.deadline_text, sourceAt: c.source_at,
        source: { type: c.source_type, label: src.label, link: src.link },
        taskId: c.linked_task_id ? String(c.linked_task_id) : null,
        confidence: Number(c.confidence),
      };
    });
  }

  /** Отметить из экрана «Обещания» (§99): выполнено / не отслеживать. */
  async mark(a: Actor, id: string, status: 'fulfilled' | 'dismissed') {
    const c = await this.repo.get(a.tenantId, String(id));
    if (!c || ![c.speaker_user_id, c.assigner_user_id].map(String).includes(String(a.userId))) throw AppException.notFound('Обещание не найдено');
    await this.close(c, status, 'user');
    return { ok: true };
  }
}
