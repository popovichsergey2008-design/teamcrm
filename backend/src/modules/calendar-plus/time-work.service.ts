import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { DbService } from '../../database/db.service';
import { CalendarBlocksService } from '../calendar/calendar-blocks.service';
import { CalendarChange, onCalendarChange } from '../calendar/calendar-hooks';
import { CalendarSeriesService } from '../calendar/calendar-series.service';
import { CalendarService } from '../calendar/calendar.service';
import { zonedParts } from '../calendar/find-time';
import { ChatsRepository } from '../chats/chats.repository';
import { onFocusPlanAccepted } from '../focus/focus-hooks';
import { InboxRepository } from '../notifications/inbox.repository';
import { RealtimeService } from '../realtime/realtime.service';
import { CalendarPlusService } from './calendar-plus.service';
import { focusFill, planWeek, relocate, WeekCtx } from './week-plan';

type Viewer = { userId: string; role: string };
const MIN = 60_000;
const DAY = 86_400_000;
const hhmm = (ms: number, tz: string) => new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: tz });
const dayName = (ms: number, tz: string) => new Date(ms).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', timeZone: tz });

/**
 * Волна 2 ТЗ «Календарь» (#4892, п. 7–10): время работает на задачи.
 * Всё, что меняет календарь, — только по явной кнопке; исключение по ТЗ одно:
 * встречу поставили на фокус — блок сам переезжает в свободное окно того же дня
 * и человеку приходит уведомление (блок не исчезает молча).
 */
@Injectable()
export class TimeWorkService implements OnModuleInit {
  private readonly log = new Logger('CalendarTimeWork');

  constructor(
    private readonly db: DbService,
    private readonly plus: CalendarPlusService,
    private readonly calendar: CalendarService,
    private readonly series: CalendarSeriesService,
    private readonly blocks: CalendarBlocksService,
    private readonly chats: ChatsRepository,
    private readonly realtime: RealtimeService,
    private readonly inbox: InboxRepository,
  ) {}

  onModuleInit(): void {
    onCalendarChange((tenantId, eventId, change) => this.onEventChange(tenantId, eventId, change));
    onFocusPlanAccepted((e) => this.onPlanAccepted(e.tenantId, { userId: e.userId, role: e.role }, e.taskIds));
  }

  /** Контекст недели человека: часы, обед, пояс и вся занятость (встречи, блоки, внешние). */
  private async ctx(tenantId: string, user: Viewer, from: number, to: number, exceptBlockId?: string): Promise<WeekCtx & { tz: string }> {
    const { prefs, input } = await this.plus.weekData(tenantId, user, from, to);
    const busy = [
      ...input.meetings.map((m) => ({ start: m.start, end: m.end })),
      ...input.blocks.filter((b) => b.id !== exceptBlockId).map((b) => ({ start: b.start, end: b.end })),
    ];
    return { now: Date.now(), from, to, timeZone: prefs.timeZone, tz: prefs.timeZone, work: input.work, lunch: input.lunch, busy };
  }

  private static bounds(from?: string, to?: string) {
    const f = from ? Date.parse(from) : NaN;
    const t = to ? Date.parse(to) : NaN;
    if (!Number.isNaN(f) && !Number.isNaN(t) && t > f && t - f <= 15 * DAY) return { from: f, to: t };
    return { from: Date.now(), to: Date.now() + 7 * DAY };
  }

  // ---------- п. 8: задачи недели и «Разложить по неделе» ----------

  async planWeekPreview(tenantId: string, user: Viewer, q: { from?: string; to?: string }) {
    const { from, to } = TimeWorkService.bounds(q.from, q.to);
    const c = await this.ctx(tenantId, user, from, to);
    const tasks = await this.db.many<{ id: string; title: string; deadline_at: Date | null; estimate_hours: string | null }>(
      `SELECT t.id::text, t.title, t.deadline_at, t.estimate_hours::text FROM tasks t
        WHERE t.tenant_id = $1 AND t.assignee_id = $2 AND t.deleted_at IS NULL AND t.closed_at IS NULL
          AND t.deadline_at IS NOT NULL AND t.deadline_at > now() AND t.deadline_at <= $3::timestamptz + interval '1 day'
          AND NOT EXISTS (SELECT 1 FROM calendar_blocks b WHERE b.task_id = t.id AND b.ends_at > now())
        ORDER BY t.deadline_at LIMIT 20`,
      [tenantId, user.userId, new Date(to).toISOString()]);
    const res = planWeek(c, tasks.map((t) => ({
      id: t.id, title: t.title, deadline: t.deadline_at ? t.deadline_at.getTime() : null,
      estimateMin: t.estimate_hours ? Math.round(Number(t.estimate_hours) * 60) : null,
    })));
    const title = new Map(tasks.map((t) => [t.id, t.title]));
    return {
      placements: res.placements.map((p) => ({
        taskId: p.taskId, title: p.title, startsAt: new Date(p.start).toISOString(), endsAt: new Date(p.end).toISOString(),
        label: `${dayName(p.start, c.tz)} ${hhmm(p.start, c.tz)}–${hhmm(p.end, c.tz)}`,
      })),
      unplaced: res.unplaced.map((id) => ({ taskId: id, title: title.get(id) ?? '' })),
    };
  }

  /** «Применить»: блоки по предложению; поверх встреч и за срок — не ставим, сроки не трогаем. */
  async planWeekApply(tenantId: string, user: Viewer, placements: { taskId: string; startsAt: string; endsAt: string }[]) {
    const created = [];
    const skipped: string[] = [];
    for (const p of placements.slice(0, 30)) {
      const clash = await this.db.one<{ id: string }>(
        `SELECT e.id::text FROM calendar_events e LEFT JOIN calendar_participants pp ON pp.event_id = e.id AND pp.user_id = $2
          WHERE e.tenant_id = $1 AND NOT e.all_day AND e.starts_at < $4::timestamptz AND e.ends_at > $3::timestamptz
            AND (e.owner_id = $2 OR (pp.user_id IS NOT NULL AND pp.status <> 'declined')) LIMIT 1`,
        [tenantId, user.userId, p.startsAt, p.endsAt]);
      const late = await this.db.one<{ late: boolean }>(
        `SELECT (deadline_at IS NOT NULL AND deadline_at < $3::timestamptz) AS late FROM tasks WHERE tenant_id = $1 AND id = $2`,
        [tenantId, p.taskId, p.endsAt]);
      if (clash || late?.late) { skipped.push(p.taskId); continue; }
      created.push((await this.blocks.create(tenantId, user.userId, { kind: 'task', taskId: p.taskId, startsAt: p.startsAt, endsAt: p.endsAt })).block);
    }
    return { created: created.length, skipped };
  }

  /** Принятый план дня — это те же блоки в календаре (п. 8). Уже запланированное не трогаем. */
  private async onPlanAccepted(tenantId: string, user: Viewer, taskIds: string[]) {
    if (!taskIds.length) return;
    const free = await this.db.many<{ id: string }>(
      `SELECT t.id::text FROM tasks t WHERE t.tenant_id = $1 AND t.id = ANY($2::bigint[])
          AND NOT EXISTS (SELECT 1 FROM calendar_blocks b WHERE b.task_id = t.id AND b.user_id = $3
                           AND b.ends_at > now() AND b.starts_at < now() + interval '1 day')`,
      [tenantId, taskIds, user.userId]);
    if (!free.length) return;
    const plan = await this.blocks.planDay(tenantId, user.userId, { items: free.map((t) => ({ taskId: t.id })) });
    if (plan.plan.length) {
      await this.blocks.applyPlan(tenantId, user.userId, plan.plan.map((p) => ({ taskId: p.taskId, startsAt: p.startsAt, endsAt: p.endsAt })));
      this.realtime.emitToUsers(tenantId, [user.userId], 'calendar.changed', { reason: 'focus-plan' });
    }
  }

  // ---------- п. 9: цель фокуса на неделю ----------

  async focusGoal(tenantId: string, user: Viewer, q: { from?: string; to?: string }) {
    const { from, to } = TimeWorkService.bounds(q.from, q.to);
    const c = await this.ctx(tenantId, user, from, to);
    const p = await this.plus.prefsRow(tenantId, user.userId);
    const goal = p?.focus_goal_min ?? 0;
    const planned = await this.db.one<{ min: number }>(
      `SELECT COALESCE(sum(EXTRACT(EPOCH FROM (ends_at - starts_at)) / 60), 0)::int AS min FROM calendar_blocks
        WHERE tenant_id = $1 AND user_id = $2 AND kind = 'focus' AND starts_at < $4::timestamptz AND ends_at > $3::timestamptz`,
      [tenantId, user.userId, new Date(from).toISOString(), new Date(to).toISOString()]);
    const plannedMin = Number(planned?.min ?? 0);
    const proposal = focusFill(c, Math.max(0, goal - plannedMin));
    return {
      goalMin: goal, plannedMin,
      proposal: proposal.map((w) => ({ startsAt: new Date(w.start).toISOString(), endsAt: new Date(w.end).toISOString(), label: `${dayName(w.start, c.tz)} ${hhmm(w.start, c.tz)}–${hhmm(w.end, c.tz)}` })),
      proposalMin: Math.round(proposal.reduce((n, w) => n + (w.end - w.start), 0) / MIN),
    };
  }

  async focusGoalApply(tenantId: string, user: Viewer, q: { from?: string; to?: string }) {
    const g = await this.focusGoal(tenantId, user, q);
    for (const w of g.proposal) {
      await this.blocks.create(tenantId, user.userId, { kind: 'focus', title: 'Фокус', startsAt: w.startsAt, endsAt: w.endsAt });
    }
    return { created: g.proposal.length };
  }

  /**
   * На фокус поставили встречу: блок переезжает в ближайшее свободное окно того же дня,
   * человеку — уведомление. Окна нет — блок остаётся, но человек узнаёт о пересечении.
   */
  private async onEventChange(tenantId: string, eventId: string, change: CalendarChange) {
    if (change !== 'saved') return;
    const ev = await this.db.one<{ starts_at: Date; ends_at: Date; title: string; all_day: boolean }>(
      `SELECT starts_at, ends_at, title, all_day FROM calendar_events WHERE tenant_id = $1 AND id = $2`, [tenantId, eventId]);
    if (!ev || ev.all_day || ev.ends_at.getTime() < Date.now()) return;
    const hit = await this.db.many<{ id: string; user_id: string; starts_at: Date; ends_at: Date; role: string }>(
      `SELECT b.id::text, b.user_id::text, b.starts_at, b.ends_at, r.code AS role
         FROM calendar_blocks b
         JOIN users u ON u.id = b.user_id JOIN roles r ON r.id = u.role_id
        WHERE b.tenant_id = $1 AND b.kind = 'focus' AND b.starts_at < $3::timestamptz AND b.ends_at > $2::timestamptz
          AND (EXISTS (SELECT 1 FROM calendar_participants p WHERE p.event_id = $4 AND p.user_id = b.user_id AND p.status <> 'declined')
               OR EXISTS (SELECT 1 FROM calendar_events e WHERE e.id = $4 AND e.owner_id = b.user_id))`,
      [tenantId, ev.starts_at.toISOString(), ev.ends_at.toISOString(), eventId]);
    for (const b of hit) {
      try {
        const user = { userId: b.user_id, role: b.role };
        const c = await this.ctx(tenantId, user, b.starts_at.getTime() - DAY, b.starts_at.getTime() + DAY, b.id);
        const to = relocate({ start: b.starts_at.getTime(), end: b.ends_at.getTime() }, c);
        const when = (s: number, e: number) => `${hhmm(s, c.tz)}–${hhmm(e, c.tz)}`;
        let title: string; let body: string;
        if (to) {
          await this.blocks.move(tenantId, b.user_id, b.id, { startsAt: new Date(to.start).toISOString(), endsAt: new Date(to.end).toISOString() });
          title = 'Фокус перенесён';
          body = `На ваш фокус ${when(b.starts_at.getTime(), b.ends_at.getTime())} поставили встречу «${ev.title}». Фокус переехал на ${when(to.start, to.end)}.`;
        } else {
          title = 'Встреча поверх фокуса';
          body = `На ваш фокус ${when(b.starts_at.getTime(), b.ends_at.getTime())} поставили встречу «${ev.title}». Свободного окна в этот день нет — фокус остался на месте.`;
        }
        await this.inbox.record({ tenantId, userId: b.user_id, mailId: null, eventKey: 'calendar.focus', title, body, path: '/calendar', details: { blockId: b.id } }).catch(() => undefined);
        this.realtime.emitToUsers(tenantId, [b.user_id], 'calendar.focus-moved', { title, body });
        this.realtime.emitToUsers(tenantId, [b.user_id], 'calendar.changed', { reason: 'focus-moved' });
      } catch (e) {
        this.log.warn(`перенос фокуса ${b.id}: ${(e as Error).message}`);
      }
    }
  }

  // ---------- п. 7: после встречи ----------

  private async meetingOf(tenantId: string, user: Viewer, meetingId: string) {
    const m = await this.db.one<{ id: string; title: string; event_id: string | null; chat_id: string | null; created_by: string | null; happened_at: Date | null; created_at: Date }>(
      `SELECT id::text, title, event_id::text, chat_id::text, created_by::text, happened_at, created_at FROM meetings WHERE tenant_id = $1 AND id = $2`,
      [tenantId, meetingId]);
    if (!m) throw AppException.notFound('Встреча не найдена');
    // видят итоги участники созвона и руководители
    const boss = user.role === 'owner' || user.role === 'manager';
    if (!boss && String(m.created_by) !== String(user.userId)) {
      const part = await this.db.one<{ ok: boolean }>(
        `SELECT TRUE AS ok FROM calendar_participants p WHERE p.event_id = $1::bigint AND p.user_id = $2
         UNION SELECT TRUE FROM chat_members cm WHERE cm.chat_id = $3::bigint AND cm.user_id = $2 LIMIT 1`,
        [m.event_id, user.userId, m.chat_id]);
      if (!part) throw AppException.forbidden('Итоги видят участники встречи');
    }
    return m;
  }

  /** Чат встречи: где созвонились или откуда назначили встречу. */
  private async chatOf(tenantId: string, m: { chat_id: string | null; event_id: string | null }) {
    if (m.chat_id) return m.chat_id;
    if (!m.event_id) return null;
    const e = await this.db.one<{ c: string | null }>(`SELECT source_chat_id::text AS c FROM calendar_events WHERE tenant_id = $1 AND id = $2`, [tenantId, m.event_id]);
    return e?.c ?? null;
  }

  /** «Создать все и отправить итоги в чат»: итоги — сообщением в чат встречи. */
  async summaryToChat(tenantId: string, user: Viewer, meetingId: string) {
    const m = await this.meetingOf(tenantId, user, meetingId);
    const chatId = await this.chatOf(tenantId, m);
    if (!chatId) throw AppException.validation('У встречи нет чата — отправьте итоги участникам');
    const [s, tasks] = await Promise.all([
      this.db.one<{ summary: string | null; decisions: unknown }>(`SELECT summary, decisions FROM meeting_summaries WHERE meeting_id = $1`, [meetingId]),
      this.db.many<{ title: string; assignee: string | null; deadline_at: Date | null; task_id: string }>(
        `SELECT t.title, u.full_name AS assignee, t.deadline_at, t.id::text AS task_id FROM meeting_task_drafts d
           JOIN tasks t ON t.id = d.task_id AND t.deleted_at IS NULL LEFT JOIN users u ON u.id = t.assignee_id
          WHERE d.tenant_id = $1 AND d.meeting_id = $2 AND d.status = 'applied' ORDER BY d.id`, [tenantId, meetingId]),
    ]);
    const decisions = (Array.isArray(s?.decisions) ? s!.decisions as unknown[] : [])
      .map((x) => (typeof x === 'string' ? x : (x as { text?: string })?.text ?? '')).filter(Boolean);
    const lines = [`Итоги встречи «${m.title}»`];
    if (s?.summary) lines.push(String(s.summary).slice(0, 500));
    if (decisions.length) lines.push('', 'Решения:', ...decisions.slice(0, 8).map((d) => `— ${d}`));
    if (tasks.length) lines.push('', 'Задачи:', ...tasks.slice(0, 12).map((t) => `— ${t.assignee ? `${t.assignee.split(' ')[0]}: ` : ''}${t.title} #${t.task_id}${t.deadline_at ? ` (до ${t.deadline_at.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Moscow' })})` : ''}`));
    const msg = await this.chats.addMessage({ tenantId, chatId, authorId: user.userId, body: lines.join('\n').slice(0, 7900), fileId: null, isAi: true });
    const to = (await this.db.many<{ user_id: string }>(`SELECT user_id::text FROM chat_members WHERE chat_id = $1`, [chatId])).map((r) => r.user_id);
    this.realtime.emitToUsers(tenantId, to, 'chat.message', { chatId, message: msg });
    return { chatId, sent: true };
  }

  /** «Следующая встреча через неделю»: те же люди, то же время, +7 дней; приглашения — как у любой встречи. */
  async nextWeek(tenantId: string, user: Viewer, meetingId: string) {
    const m = await this.meetingOf(tenantId, user, meetingId);
    let starts: number; let ends: number; let ids: string[]; let title = m.title;
    if (m.event_id) {
      const e = await this.db.one<{ starts_at: Date; ends_at: Date; title: string }>(`SELECT starts_at, ends_at, title FROM calendar_events WHERE id = $1`, [m.event_id]);
      const p = await this.db.many<{ user_id: string }>(`SELECT user_id::text FROM calendar_participants WHERE event_id = $1 AND status <> 'declined'`, [m.event_id]);
      starts = (e?.starts_at ?? m.happened_at ?? m.created_at).getTime() + 7 * DAY;
      ends = (e?.ends_at?.getTime() ?? starts - 7 * DAY + 30 * MIN) + 7 * DAY;
      ids = p.map((x) => x.user_id);
      title = e?.title ?? title;
    } else {
      const at = (m.happened_at ?? m.created_at).getTime();
      starts = Math.round((at + 7 * DAY) / (30 * MIN)) * 30 * MIN;
      ends = starts + 30 * MIN;
      const room = await this.db.one<{ ids: string[] }>(
        `SELECT participant_ids::text[] AS ids FROM call_log c JOIN meetings mm ON mm.room_id = c.room_id
          WHERE mm.id = $1 ORDER BY c.started_at DESC LIMIT 1`, [meetingId]);
      ids = room?.ids ?? [];
    }
    const ev = await this.plus.createEvent(tenantId, user, {
      title, startsAt: new Date(starts).toISOString(), endsAt: new Date(ends).toISOString(),
      participantIds: ids, via: 'assistant',
    }) as unknown as { id: string };
    return { eventId: String(ev.id), startsAt: new Date(starts).toISOString() };
  }

  /** Похожая задача уже есть — «Добавить в #1326»: поручение комментарием в неё, без дубля. */
  async mergeDraft(tenantId: string, user: Viewer, draftId: string, taskId: string) {
    const d = await this.db.one<{ meeting_id: string; title: string; source_sec: string | null; status: string }>(
      `SELECT meeting_id::text, title, source_sec::text, status FROM meeting_task_drafts WHERE tenant_id = $1 AND id = $2`, [tenantId, draftId]);
    if (!d) throw AppException.notFound('Черновик не найден');
    if (d.status === 'applied') throw AppException.conflict('Черновик уже разобран');
    const m = await this.meetingOf(tenantId, user, d.meeting_id);
    const t = await this.db.one<{ id: string }>(`SELECT id::text FROM tasks WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`, [tenantId, taskId]);
    if (!t) throw AppException.notFound('Задача не найдена');
    const sec = d.source_sec == null ? null : Math.round(Number(d.source_sec));
    const stamp = sec == null ? '' : ` (из фразы в ${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')})`;
    await this.db.query(
      `INSERT INTO task_comments (tenant_id, task_id, author_id, body) VALUES ($1, $2, $3, $4)`,
      [tenantId, taskId, user.userId, `Со встречи «${m.title}»${stamp}: ${d.title}`]);
    await this.db.query(`UPDATE meeting_task_drafts SET status = 'applied', task_id = $3 WHERE tenant_id = $1 AND id = $2`, [tenantId, draftId, taskId]);
    return { merged: true, taskId };
  }

  /** «итоги готовы» у встреч календаря (п. 7): событие → разбор. */
  summaries(tenantId: string, userId: string, from: string, to: string) {
    return this.db.many<{ event_id: string; meeting_id: string }>(
      `SELECT DISTINCT ON (e.id) e.id::text AS event_id, m.id::text AS meeting_id
         FROM calendar_events e
         JOIN meetings m ON m.tenant_id = e.tenant_id AND m.status = 'done'
              AND (m.event_id = e.id OR (e.meet_room_id IS NOT NULL AND m.room_id = e.meet_room_id))
         LEFT JOIN calendar_participants p ON p.event_id = e.id AND p.user_id = $2
        WHERE e.tenant_id = $1 AND e.starts_at < $4::timestamptz AND e.ends_at > $3::timestamptz
          AND (e.owner_id = $2 OR p.user_id IS NOT NULL OR e.scope = 'company')
        ORDER BY e.id, m.created_at DESC`,
      [tenantId, userId, from, to]);
  }

  // ---------- п. 10: перенос при отказах ----------

  /** Отказ с причиной: «в это время у врача» — организатор увидит её в баннере. */
  async decline(tenantId: string, userId: string, eventId: string, comment: string | null) {
    const r = await this.calendar.respond(tenantId, userId, eventId, 'declined');
    await this.db.query(`UPDATE calendar_participants SET comment = $3 WHERE event_id = $1 AND user_id = $2`,
      [eventId, userId, comment?.trim().slice(0, 300) || null]);
    const ev = await this.db.one<{ owner_id: string; title: string }>(`SELECT owner_id::text, title FROM calendar_events WHERE id = $1`, [eventId]);
    if (ev && ev.owner_id !== String(userId)) this.realtime.emitToUsers(tenantId, [ev.owner_id], 'calendar.changed', { reason: 'declined', eventId });
    return r;
  }

  /**
   * Баннер переноса: отказалась половина участников или ключевой (соорганизатор) — причины
   * отказов и 2 слота, когда свободны все. null — переносить не из-за чего.
   */
  async declines(tenantId: string, user: Viewer, eventId: string) {
    const ev = await this.calendar.details(tenantId, user, eventId) as { canEdit: boolean; title: string; startsAt: string | Date; endsAt: string | Date };
    const rows = await this.db.many<{ user_id: string; full_name: string; status: string; comment: string | null; is_organizer: boolean; is_co_organizer: boolean }>(
      `SELECT p.user_id::text, u.full_name, p.status, p.comment, p.is_organizer, COALESCE(p.is_co_organizer, false) AS is_co_organizer
         FROM calendar_participants p JOIN users u ON u.id = p.user_id WHERE p.event_id = $1`, [eventId]);
    const others = rows.filter((r) => !r.is_organizer);
    const declined = others.filter((r) => r.status === 'declined');
    const key = declined.some((r) => r.is_co_organizer);
    const triggered = others.length > 0 && (declined.length * 2 >= others.length || key);
    const start = new Date(ev.startsAt).getTime();
    const base = {
      eventId, title: ev.title, canEdit: ev.canEdit, total: others.length, triggered,
      declined: declined.map((r) => ({ name: r.full_name.split(' ')[0], comment: r.comment })),
    };
    if (!triggered || !ev.canEdit || start < Date.now()) return { ...base, slots: [] as unknown[] };
    const best = await this.plus.bestTime(tenantId, user, {
      participantIds: others.map((r) => r.user_id), minutes: Math.max(15, Math.round((new Date(ev.endsAt).getTime() - start) / MIN)),
      exceptEventId: eventId, days: 10,
    });
    return { ...base, slots: best.slots.slice(0, 2) };
  }

  /**
   * «Перенести»: новое время, новые приглашения всем (статусы — заново «не ответил»)
   * и сообщение в чат встречи. Два нажатия: «Перенести» → слот.
   */
  async reschedule(tenantId: string, user: Viewer, eventId: string, startsAt: string, endsAt: string) {
    const before = await this.calendar.details(tenantId, user, eventId) as { canEdit: boolean; title: string; sourceChatId?: string | null };
    if (!before.canEdit) throw AppException.forbidden('Переносит организатор встречи');
    await this.db.query(
      `UPDATE calendar_participants SET status = 'invited', comment = NULL WHERE event_id = $1 AND NOT is_organizer`, [eventId]);
    await this.series.update(tenantId, user, eventId, { startsAt, endsAt }, 'one');
    const chatId = before.sourceChatId ?? null;
    if (chatId) {
      const tz = await this.plus.timezoneOf(tenantId, user.userId);
      const s = Date.parse(startsAt);
      const msg = await this.chats.addMessage({
        tenantId, chatId, authorId: user.userId, fileId: null, isAi: true,
        body: `Встречу «${before.title}» перенесли на ${dayName(s, tz)} ${hhmm(s, tz)}–${hhmm(Date.parse(endsAt), tz)}. Приглашения обновлены.`,
      });
      const to = (await this.db.many<{ user_id: string }>(`SELECT user_id::text FROM chat_members WHERE chat_id = $1`, [chatId])).map((r) => r.user_id);
      this.realtime.emitToUsers(tenantId, to, 'chat.message', { chatId, message: msg });
    }
    return this.calendar.details(tenantId, user, eventId);
  }

  /** Встречи недели с отказами — для «Ассистента недели». */
  async declinedMeetings(tenantId: string, userId: string, from: string, to: string) {
    return this.db.many<{ id: string; title: string; starts_at: Date; total: number; declined: number; key: boolean }>(
      `SELECT e.id::text, e.title, e.starts_at,
              count(*) FILTER (WHERE NOT p.is_organizer)::int AS total,
              count(*) FILTER (WHERE NOT p.is_organizer AND p.status = 'declined')::int AS declined,
              bool_or(COALESCE(p.is_co_organizer, false) AND p.status = 'declined') AS key
         FROM calendar_events e JOIN calendar_participants p ON p.event_id = e.id
        WHERE e.tenant_id = $1 AND e.owner_id = $2 AND e.starts_at > now() AND e.starts_at < $4::timestamptz AND e.ends_at > $3::timestamptz
        GROUP BY e.id HAVING count(*) FILTER (WHERE NOT p.is_organizer AND p.status = 'declined') > 0`,
      [tenantId, userId, from, to]);
  }

  /** Подсказки «Ассистента недели» об отказах (п. 10): баннер и 2 слота, когда свободны все. */
  async declinedSuggestions(tenantId: string, user: Viewer, from: string, to: string, dismissed: string[]) {
    if (dismissed.includes('declined')) return [];
    const tz = await this.plus.timezoneOf(tenantId, user.userId);
    const out = [];
    for (const m of await this.declinedMeetings(tenantId, user.userId, from, to)) {
      if (dismissed.includes(`declined:${m.id}`)) continue;
      const d = await this.declines(tenantId, user, m.id).catch(() => null);
      if (!d || !d.triggered || !(d.slots as unknown[]).length) continue;
      const slot = (d.slots as { startsAt: string; endsAt: string; label: string }[])[0];
      const why = d.declined.map((x) => `${x.name}: ${x.comment ? `«${x.comment}»` : 'без комментария'}`).join(' · ');
      out.push({
        key: `declined:${m.id}`, kind: 'declined', tone: 'warn',
        title: `${d.declined.length} из ${d.total} участников отклонили`,
        text: `«${m.title}» ${dayName(m.starts_at.getTime(), tz)} ${hhmm(m.starts_at.getTime(), tz)}. ${why}. Перенести на ${slot.label} — все свободны?`,
        action: { label: 'Перенести', kind: 'reschedule' },
        preview: [{ label: m.title, before: `${dayName(m.starts_at.getTime(), tz)} ${hhmm(m.starts_at.getTime(), tz)}`, after: `${slot.label} · все свободны` }],
        slot: { startsAt: slot.startsAt, endsAt: slot.endsAt },
      });
    }
    return out;
  }

  async applyDeclined(tenantId: string, user: Viewer, key: string) {
    const id = key.replace(/^declined:/, '');
    const d = await this.declines(tenantId, user, id);
    const slot = (d.slots as { startsAt: string; endsAt: string }[])[0];
    if (!d.triggered || !slot) throw AppException.conflict('Подсказка уже неактуальна');
    await this.reschedule(tenantId, user, id, slot.startsAt, slot.endsAt);
    return { applied: key };
  }

  /** День человека словами — для агента (п. 13). */
  static dayKey(ms: number, tz: string) { return zonedParts(ms, tz).date; }
}
