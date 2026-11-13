import { Injectable, Logger } from '@nestjs/common';
import { isRealAgreement, normalizePhrase } from '../../common/agreement-filter';
import { AppException } from '../../common/http/app-exception';
import { DbService } from '../../database/db.service';
import { stageSql } from '../tasks/responsibility';
import { AiService } from '../ai/ai.service';
import { CalendarBlocksService } from '../calendar/calendar-blocks.service';
import { zonedParts, zonedToUtc } from '../calendar/find-time';
import { CalendarPlusService } from '../calendar-plus/calendar-plus.service';
import { FocusDayService } from '../focus/focus-day.service';
import { PushService } from '../notifications/push.service';
import { TasksService } from '../tasks/tasks.service';
import { hours, shortTitle } from './day-plan';
import { FocusPlusService } from './focus-plus.service';

type Viewer = { tenantId: string; userId: string; role: string };
const MIN = 60_000;
const DAY = 86_400_000;

const SPLIT_SYSTEM = 'Разбей фразу человека о делах на сегодня на отдельные задачи. Ответь JSON-массивом объектов {"title": "коротко, с глагола", "minutes": число минут 15..240}. Не выдумывай задач, которых нет во фразе.';

/** Фразу «главное сегодня» — в задачи без модели: по строкам, «;», «, а потом», «и ещё». */
export function splitPhrase(text: string): string[] {
  return text
    .split(/\n|;|\s+(?:а потом|потом|затем|и ещё|и еще|плюс)\s+|,\s+(?=[а-яё]+(?:ть|ти|чь)\s)/i)
    .map((s) => s.replace(/^[\s,.\-—•\d)]+/, '').replace(/[\s.]+$/, '').trim())
    .filter((s) => s.length >= 3)
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .slice(0, 5);
}

/**
 * «Фокус дня» #4891, волна 2: пересмотр плана «до / после» (п. 7), договорённости со
 * встреч только настоящие (п. 8), завершение дня за 2 минуты (п. 10), первый день (п. 11).
 * Ничего не меняется без нажатия; сроки задач здесь не трогаются никогда.
 */
@Injectable()
export class FocusWave2Service {
  private readonly log = new Logger('FocusWave2');

  constructor(
    private readonly db: DbService,
    private readonly plus: FocusPlusService,
    private readonly focus: FocusDayService,
    private readonly cal: CalendarPlusService,
    private readonly blocks: CalendarBlocksService,
    private readonly tasks: TasksService,
    private readonly push: PushService,
    private readonly ai: AiService,
  ) {}

  private async today(v: Viewer) {
    const prefs = await this.cal.prefs(v.tenantId, v.userId);
    return { prefs, tz: prefs.timeZone, date: zonedParts(Date.now(), prefs.timeZone).date };
  }

  // ---------- п. 7: пришло срочное ----------

  /** Предложение: срочное — в резерв; «Сейчас» и «Предложение ИИ» рядом; главные задачи не двигаются. */
  async replan(v: Viewer) {
    const t = await this.focus.today(v) as unknown as { enabled: boolean; criticalCandidate: null | { key: string; kind: string; taskId: string | null; approvalId: string | null; title: string; reasons: string[] } };
    const { date } = await this.today(v);
    const last = await this.lastReplan(v, date);
    const c = t.enabled ? t.criticalCandidate : null;
    if (!c) return { urgent: null, revertable: last };
    const d = await this.plus.day(v);
    if (!d.enabled) return { urgent: null, revertable: last };
    const info = c.taskId ? await this.db.one<{ author: string | null; deadline_at: Date | null; estimate_hours: string | null; chat_title: string | null; msg_author: string | null; msg_text: string | null }>(
      `SELECT ua.full_name AS author, t.deadline_at, t.estimate_hours::text,
              ch.title AS chat_title, mu.full_name AS msg_author, left(m.body, 160) AS msg_text
         FROM tasks t
         LEFT JOIN users ua ON ua.id = t.created_by
         LEFT JOIN chat_messages m ON m.id = t.source_chat_message_id
         LEFT JOIN chats ch ON ch.id = m.chat_id
         LEFT JOIN users mu ON mu.id = m.author_id
        WHERE t.tenant_id = $1 AND t.id = $2`, [v.tenantId, c.taskId]) : null;
    const minutes = info?.estimate_hours ? Math.max(15, Math.round(Number(info.estimate_hours) * 60)) : c.kind === 'approval' ? 15 : 60;
    const reserve = d.timeline.find((s) => s.kind === 'reserve' && Date.parse(s.endsAt) > Date.now());
    const slotStart = reserve ? Math.max(Date.parse(reserve.startsAt), Math.ceil(Date.now() / (5 * MIN)) * 5 * MIN) : null;
    const slotEnd = reserve && slotStart ? Math.min(Date.parse(reserve.endsAt), slotStart + minutes * MIN) : null;
    const eaten = slotStart && slotEnd ? Math.round((slotEnd - slotStart) / MIN) : 0;
    const after = d.timeline.flatMap((s) => {
      if (!reserve || s !== reserve || !slotStart || !slotEnd) return [s];
      const out = [];
      if (slotStart > Date.parse(s.startsAt)) out.push({ ...s, endsAt: new Date(slotStart).toISOString() });
      out.push({ kind: 'urgent' as const, title: shortTitle(c.title), startsAt: new Date(slotStart).toISOString(), endsAt: new Date(slotEnd).toISOString(), taskId: c.taskId });
      if (slotEnd < Date.parse(s.endsAt)) out.push({ ...s, startsAt: new Date(slotEnd).toISOString() });
      return out;
    });
    const tz = d.timeZone;
    return {
      urgent: {
        key: c.key, kind: c.kind, taskId: c.taskId, title: shortTitle(c.title), reasons: c.reasons.slice(0, 3),
        source: info?.chat_title
          ? { kind: 'chat', label: `чат «${info.chat_title}»${info.msg_author ? `, ${info.msg_author}` : ''}`, quote: info.msg_text }
          : { kind: 'task', label: info?.author ? `поставил(а): ${info.author}` : 'новая задача', quote: null },
        deadline: info?.deadline_at
          ? `срок из задачи #${c.taskId}: ${new Date(info.deadline_at).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: tz })}`
          : 'срока нет — срочность по приоритету',
        minutes, reserveEaten: eaten, reserveLeft: Math.max(0, d.capacity.reserveMin - eaten),
        fits: !!reserve && eaten >= Math.min(minutes, 15),
      },
      before: d.timeline, after,
      revertable: last,
    };
  }

  private async lastReplan(v: Viewer, date: string) {
    const r = await this.db.one<{ id: string; title: string }>(
      `SELECT id::text, title FROM focus_replans WHERE user_id = $1 AND focus_date = $2::date AND reverted_at IS NULL ORDER BY id DESC LIMIT 1`,
      [v.userId, date]);
    return r ? { id: r.id, title: r.title } : null;
  }

  /** «Принять»: срочное встаёт в резерв блоком календаря. Главные задачи и сроки не трогаются. */
  async replanAccept(v: Viewer, key: string) {
    const p = await this.replan(v);
    if (!p.urgent || p.urgent.key !== key) throw AppException.conflict('Предложение уже неактуально — обновите экран');
    const slot = p.after?.find((s) => s.kind === 'urgent');
    if (!slot) throw AppException.conflict('В резерве сегодня нет места — оставьте план или отложите во входящие');
    const { date } = await this.today(v);
    const made = p.urgent.taskId && p.urgent.kind === 'task'
      ? await this.blocks.create(v.tenantId, v.userId, { kind: 'task', taskId: p.urgent.taskId, startsAt: slot.startsAt, endsAt: slot.endsAt })
      : await this.blocks.create(v.tenantId, v.userId, { kind: 'focus', title: p.urgent.title, taskIds: [], startsAt: slot.startsAt, endsAt: slot.endsAt });
    await this.db.query(
      `INSERT INTO focus_replans (tenant_id, user_id, focus_date, item_key, title, block_id) VALUES ($1, $2, $3::date, $4, $5, $6)`,
      [v.tenantId, v.userId, date, key.slice(0, 80), p.urgent.title.slice(0, 255), made.block.id]);
    await this.focus.dismiss(v, key);
    return this.replan(v);
  }

  /** «Оставить план» — предложение больше не показывается сегодня. */
  async replanKeep(v: Viewer, key: string) {
    await this.focus.dismiss(v, key);
    return this.replan(v);
  }

  /** «Отложить во входящие» — запись в «Входящих», план не меняется. */
  async replanInbox(v: Viewer, key: string) {
    const p = await this.replan(v);
    const u = p.urgent && p.urgent.key === key ? p.urgent : null;
    await this.focus.dismiss(v, key);
    if (u) {
      const proj = u.taskId ? await this.db.one<{ project_id: string }>(`SELECT project_id::text FROM tasks WHERE tenant_id = $1 AND id = $2`, [v.tenantId, u.taskId]) : null;
      await this.push.personal({
        tenantId: v.tenantId, userId: v.userId, eventKey: 'focus.later', push: false,
        title: `Отложено: ${u.title}`, body: `${u.source.label} · ${u.deadline}`,
        path: u.taskId && proj ? `/projects/${proj.project_id}/task/${u.taskId}` : '/focus', taskId: u.taskId,
      });
    }
    return this.replan(v);
  }

  /** «Вернуть как было» — в течение дня: блок срочного убирается, план — прежний. */
  async replanRevert(v: Viewer) {
    const { date } = await this.today(v);
    const last = await this.db.one<{ id: string; block_id: string | null }>(
      `SELECT id::text, block_id::text FROM focus_replans WHERE user_id = $1 AND focus_date = $2::date AND reverted_at IS NULL ORDER BY id DESC LIMIT 1`,
      [v.userId, date]);
    if (!last) throw AppException.conflict('Сегодня план не пересматривали');
    if (last.block_id) await this.blocks.remove(v.tenantId, v.userId, last.block_id).catch(() => undefined);
    await this.db.query(`UPDATE focus_replans SET reverted_at = now() WHERE id = $1`, [last.id]);
    return this.replan(v);
  }

  // ---------- п. 9: что связывает с коллегой ----------

  /** «Ждёт вашей проверки»: сданное коллегой мне на проверку — по людям. */
  async teamLinks(v: Viewer) {
    const rows = await this.db.many<{ user_id: string; n: number }>(
      `SELECT t.assignee_id::text AS user_id, count(*)::int AS n
         FROM tasks t JOIN board_columns bc ON bc.id = t.column_id JOIN projects p ON p.id = t.project_id
        WHERE t.tenant_id = $1 AND t.created_by = $2 AND t.assignee_id IS NOT NULL AND t.assignee_id <> $2
          AND t.closed_at IS NULL AND t.deleted_at IS NULL AND p.status <> 'archived'
          AND ${stageSql('t')} IN ('testing', 'review', 'approval')
        GROUP BY t.assignee_id`, [v.tenantId, v.userId]);
    return Object.fromEntries(rows.map((r) => [r.user_id, { waitingMyReview: r.n }]));
  }

  // ---------- п. 8: договорённости со встреч ----------

  async learned(tenantId: string): Promise<string[]> {
    return (await this.db.many<{ phrase: string }>(`SELECT phrase FROM focus_not_promises WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 500`, [tenantId])).map((r) => r.phrase);
  }

  /** Карточки договорённостей за 3 дня: цитата, кто сказал, время в записи, срок, похожая задача. */
  async agreements(v: Viewer) {
    const rows = await this.db.many<{
      id: string; meeting_id: string; meeting_title: string; title: string; quote: string | null; source_speaker: string | null;
      source_sec: string | null; deadline_at: Date | null; assignee_id: string | null; assignee_name: string | null; assignee_hint: string | null;
      project_id: string | null;
    }>(
      `SELECT d.id::text, d.meeting_id::text, m.title AS meeting_title, d.title, d.quote, d.source_speaker, d.source_sec::text,
              d.deadline_at, d.assignee_id::text, ua.full_name AS assignee_name, d.assignee_hint, d.project_id::text
         FROM meeting_task_drafts d
         JOIN meetings m ON m.id = d.meeting_id
         LEFT JOIN users ua ON ua.id = d.assignee_id
        WHERE d.tenant_id = $1 AND d.status = 'pending' AND d.created_at > now() - interval '3 days'
          AND (d.assignee_id = $2 OR m.created_by = $2
               OR EXISTS (SELECT 1 FROM meeting_postcall_reviews r, jsonb_array_elements(r.participants) e
                           WHERE r.meeting_id = m.id AND e->>'userId' = ($2::bigint)::text))
        ORDER BY d.created_at DESC LIMIT 30`, [v.tenantId, v.userId]);
    const learned = await this.learned(v.tenantId);
    const real = rows.filter((r) => isRealAgreement(r.quote || r.title, learned));
    const out = [];
    for (const r of real.slice(0, 10)) {
      out.push({
        id: r.id, meetingId: r.meeting_id, meetingTitle: r.meeting_title, title: r.title,
        quote: r.quote, speaker: r.source_speaker,
        at: r.source_sec != null ? `${Math.floor(Number(r.source_sec) / 60)}:${String(Math.floor(Number(r.source_sec) % 60)).padStart(2, '0')}` : null,
        deadlineAt: r.deadline_at, assigneeId: r.assignee_id, assigneeName: r.assignee_name ?? r.assignee_hint,
        similar: await this.similarTask(v, r.title),
      });
    }
    return { items: out, hidden: rows.length - real.length };
  }

  /** Похожая открытая задача — «Добавить в #4880» вместо дубля: доля общих слов названия. */
  private async similarTask(v: Viewer, title: string) {
    const ws = [...new Set(title.toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3))].slice(0, 6);
    if (ws.length < 2) return null;
    const rows = await this.db.many<{ id: string; title: string; project_id: string }>(
      `SELECT t.id::text, t.title, t.project_id::text FROM tasks t
        WHERE t.tenant_id = $1 AND t.deleted_at IS NULL AND t.closed_at IS NULL
          AND (t.assignee_id = $2 OR t.created_by = $2)
          AND (SELECT count(*) FROM unnest($3::text[]) w WHERE replace(lower(t.title), 'ё', 'е') LIKE '%' || w || '%') >= GREATEST(2, ceil(cardinality($3::text[]) * 0.6))
        ORDER BY t.updated_at DESC LIMIT 1`, [v.tenantId, v.userId, ws]);
    return rows[0] ? { id: rows[0].id, title: shortTitle(rows[0].title), projectId: rows[0].project_id } : null;
  }

  /** «Добавить в #N»: договорённость — пунктом чек-листа найденной задачи, черновик закрыт. */
  async attachAgreement(v: Viewer, draftId: string, taskId: string) {
    const d = await this.db.one<{ title: string; quote: string | null }>(
      `SELECT title, quote FROM meeting_task_drafts WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`, [v.tenantId, draftId]);
    if (!d) throw AppException.notFound('Договорённость уже разобрана');
    const t = await this.db.one<{ id: string }>(
      `SELECT id::text FROM tasks WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL AND (assignee_id = $3 OR created_by = $3)`, [v.tenantId, taskId, v.userId]);
    if (!t) throw AppException.forbidden('Добавлять можно в свои задачи');
    await this.db.query(
      `INSERT INTO task_checklist_items (tenant_id, task_id, text, position)
       VALUES ($1, $2, $3, COALESCE((SELECT max(position) + 1 FROM task_checklist_items WHERE task_id = $2), 0))`,
      [v.tenantId, taskId, d.title.slice(0, 500)]);
    await this.db.query(`UPDATE meeting_task_drafts SET status = 'applied', task_id = $3 WHERE tenant_id = $1 AND id = $2`, [v.tenantId, draftId, taskId]);
    return { attached: taskId };
  }

  /** «Это не обещание»: черновик отклонён, фраза уходит из брифа и учит фильтр компании. */
  async notPromise(v: Viewer, draftId: string) {
    const d = await this.db.one<{ title: string; quote: string | null }>(
      `SELECT title, quote FROM meeting_task_drafts WHERE tenant_id = $1 AND id = $2`, [v.tenantId, draftId]);
    if (!d) throw AppException.notFound('Договорённость не найдена');
    await this.db.query(`UPDATE meeting_task_drafts SET status = 'rejected' WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`, [v.tenantId, draftId]);
    const phrase = normalizePhrase(d.quote || d.title);
    if (phrase) {
      await this.db.query(
        `INSERT INTO focus_not_promises (tenant_id, phrase, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [v.tenantId, phrase, v.userId]);
    }
    return { learned: true };
  }

  // ---------- п. 10: завершение дня ----------

  /** Итог без слов «провал»: готово N из 3, глубокая работа, проверки, что сдвинулось; хвосты с шагом. */
  async closeSummary(v: Viewer) {
    const base = await this.focus.closeSummary(v) as unknown as {
      topDone: number; topTotal: number; deepMinutes: number; unblocked: number; meetings: number; secondaryLeft: number; quietDefault: boolean;
      remaining: { id: string; kind: string; taskId: string | null; title: string | null }[];
    };
    const { date, tz } = await this.today(v);
    const [y, m, d] = date.split('-').map(Number);
    const from = new Date(zonedToUtc(y, m, d, 0, 0, tz));
    const moved = await this.db.one<{ n: number }>(
      `SELECT count(DISTINCT a.task_id)::int AS n FROM task_activity a JOIN tasks t ON t.id = a.task_id
        WHERE a.tenant_id = $1 AND t.assignee_id = $2 AND a.created_at >= $3
          AND (a.kind = 'deadline_shifted' OR (a.kind = 'updated' AND a.detail->'fields' ? 'deadlineAt'))`,
      [v.tenantId, v.userId, from]);
    const ids = base.remaining.map((r) => r.taskId).filter((x): x is string => !!x);
    const notes = ids.length ? await this.db.many<{ task_id: string; next_step: string | null; steps_done: string[] }>(
      `SELECT task_id::text, next_step, steps_done FROM task_focus_notes WHERE user_id = $1 AND task_id = ANY($2::bigint[])`, [v.userId, ids]) : [];
    const by = new Map(notes.map((n) => [n.task_id, n]));
    const all = base.topTotal > 0 && base.topDone === base.topTotal;
    return {
      ...base,
      headline: base.topTotal ? (all ? `Отличный день: ${base.topDone} из ${base.topTotal}` : `Хороший день: ${base.topDone} из ${base.topTotal}`) : 'День позади',
      deepHours: hours(base.deepMinutes), reviewsDone: base.unblocked, moved: moved?.n ?? 0,
      remaining: base.remaining.map((r) => ({
        ...r, done: r.taskId ? (by.get(r.taskId)?.steps_done ?? []).slice(-3) : [], nextStep: r.taskId ? by.get(r.taskId)?.next_step ?? null : null,
      })),
    };
  }

  /**
   * «Завершить день»: шаги и «когда дальше» по хвостам (сроки не меняются — только блоки
   * календаря), «Завтра начните с…» на утро следующего рабочего дня, статус «Не в сети».
   */
  async close(v: Viewer, dto: {
    startWith?: string | null; quiet: boolean;
    items: { itemId: string; taskId?: string | null; nextStep?: string | null; when: 'tomorrow' | 'date' | 'inbox'; date?: string | null }[];
  }) {
    const { prefs, tz, date } = await this.today(v);
    const tomorrowPin: string[] = [];
    for (const it of dto.items.slice(0, 10)) {
      if (it.taskId && it.nextStep !== undefined) await this.plus.saveNote(v, it.taskId, { nextStep: it.nextStep }).catch(() => undefined);
      if (!it.taskId || it.when === 'inbox') continue;
      const day = it.when === 'tomorrow' ? await this.nextWorkday(prefs.company.weekendDays, date) : it.date;
      if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const [y, m, d] = day.split('-').map(Number);
      const [wh, wm] = it.when === 'tomorrow' ? [10, 0] : prefs.workStart.split(':').map(Number);
      const start = zonedToUtc(y, m, d, wh, wm || 0, tz);
      const est = await this.db.one<{ h: string | null }>(`SELECT estimate_hours::text AS h FROM tasks WHERE id = $1`, [it.taskId]);
      const len = Math.min(240, Math.max(30, est?.h ? Math.round(Number(est.h) * 60) : 60));
      await this.blocks.create(v.tenantId, v.userId, { kind: 'task', taskId: it.taskId, startsAt: new Date(start).toISOString(), endsAt: new Date(start + len * MIN).toISOString() })
        .catch((e) => this.log.warn(`блок на ${day}: ${(e as Error).message}`));
      if (it.when === 'tomorrow') tomorrowPin.push(it.itemId);
    }
    const text = dto.startWith?.trim().slice(0, 500);
    if (text) {
      const next = await this.nextWorkday(prefs.company.weekendDays, date);
      await this.db.query(
        `INSERT INTO focus_start_with (user_id, tenant_id, focus_date, text) VALUES ($1, $2, $3::date, $4)
         ON CONFLICT (user_id, focus_date) DO UPDATE SET text = EXCLUDED.text, created_at = now()`,
        [v.userId, v.tenantId, next, text]);
    }
    return this.focus.close(v, { tomorrow: tomorrowPin, quiet: dto.quiet });
  }

  private async nextWorkday(weekend: number[], today: string) {
    for (let i = 1; i <= 7; i++) {
      const dt = new Date(Date.parse(`${today}T12:00:00Z`) + i * DAY);
      if (!weekend.includes(dt.getUTCDay())) return dt.toISOString().slice(0, 10);
    }
    return new Date(Date.parse(`${today}T12:00:00Z`) + DAY).toISOString().slice(0, 10);
  }

  /** Мягкое «Завершить день» в конце рабочего дня — одно в день, если день не закрыт. */
  async remindClose(): Promise<number> {
    const plans = await this.db.many<{ id: string; tenant_id: string; user_id: string; role: string }>(
      `SELECT p.id::text, p.tenant_id::text, p.user_id::text, r.code AS role
         FROM focus_day_plans p JOIN users u ON u.id = p.user_id JOIN roles r ON r.id = u.role_id
        WHERE p.focus_date >= current_date - 1 AND p.closed_at IS NULL AND p.close_reminded_at IS NULL
          AND p.status <> 'proposed' AND u.is_active`);
    let sent = 0;
    for (const p of plans) {
      const v = { tenantId: p.tenant_id, userId: p.user_id, role: p.role };
      try {
        const { prefs, tz, date } = await this.today(v);
        const [y, m, d] = date.split('-').map(Number);
        const [eh, em] = prefs.workEnd.split(':').map(Number);
        const end = zonedToUtc(y, m, d, eh, em || 0, tz);
        if (Date.now() < end || Date.now() > end + 90 * MIN) continue;
        const claimed = await this.db.one<{ id: string }>(
          `UPDATE focus_day_plans SET close_reminded_at = now() WHERE id = $1 AND close_reminded_at IS NULL AND focus_date = $2::date RETURNING id::text`, [p.id, date]);
        if (!claimed) continue;
        await this.push.personal({
          tenantId: v.tenantId, userId: v.userId, eventKey: 'focus.close_day', toast: true,
          title: 'Завершить день?', body: 'Две минуты: итоги, шаг на завтра — и тишина до утра.', path: '/focus?close=1',
        });
        sent++;
      } catch (e) { this.log.warn(`напоминание «Завершить день» ${p.user_id}: ${(e as Error).message}`); }
    }
    return sent;
  }

  /** «Завтра начните с…» на сегодня — первой строкой утреннего брифа. */
  async startWith(v: Viewer, date: string) {
    const r = await this.db.one<{ text: string }>(`SELECT text FROM focus_start_with WHERE user_id = $1 AND focus_date = $2::date`, [v.userId, date]);
    return r?.text ?? null;
  }

  // ---------- п. 11: первый день ----------

  /**
   * Три шага: рабочие часы → «Что главное сегодня?» → принять план. Фраза — в задачи с
   * оценками (модель, без неё — по правилам), задачи — в свободные окна дня блоками.
   */
  async firstDay(v: Viewer, dto: { workStart: string; workEnd: string; text: string }) {
    if (!/^\d{2}:\d{2}$/.test(dto.workStart) || !/^\d{2}:\d{2}$/.test(dto.workEnd) || dto.workStart >= dto.workEnd) {
      throw AppException.validation('Укажите рабочие часы, например 09:00–18:00');
    }
    await this.cal.savePrefs(v.tenantId, v.userId, { workStart: dto.workStart, workEnd: dto.workEnd });
    let items: { title: string; minutes: number }[] = [];
    try {
      const raw = await this.ai.generate(v.tenantId, SPLIT_SYSTEM, dto.text.slice(0, 1500), 'focus_first_day');
      const arr = JSON.parse(String(raw).match(/\[[\s\S]*\]/)?.[0] ?? '[]') as { title?: string; minutes?: number }[];
      items = arr.filter((x) => x.title && x.title.length > 2).slice(0, 5)
        .map((x) => ({ title: String(x.title).slice(0, 200), minutes: Math.max(15, Math.min(240, Math.round(Number(x.minutes) / 15) * 15 || 60)) }));
    } catch (e) { this.log.warn(`первый день, модель: ${(e as Error).message}`); }
    if (!items.length) items = splitPhrase(dto.text).map((title) => ({ title, minutes: 60 }));
    if (!items.length) throw AppException.validation('Напишите, что главное сегодня — хотя бы одно дело');
    const project = await this.db.one<{ id: string }>(
      `SELECT p.id::text FROM projects p
        WHERE p.tenant_id = $1 AND p.status = 'active' AND NOT p.is_demo
        ORDER BY EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $2) DESC,
                 EXISTS (SELECT 1 FROM tasks t WHERE t.project_id = p.id AND t.assignee_id = $2) DESC, p.id LIMIT 1`, [v.tenantId, v.userId]);
    if (!project) throw AppException.validation('Сначала нужен проект — создайте его в «Проектах», и план соберётся за минуту');
    const created: string[] = [];
    for (const it of items) {
      const t = await this.tasks.create(v.tenantId, {
        projectId: project.id, title: it.title, assigneeId: v.userId, estimateHours: Math.round(it.minutes / 6) / 10,
        confirmWorkload: true, confirmedWithoutTags: true,
      } as never, v.userId);
      created.push(String(t.id));
    }
    // разложить по дню: свободные окна сегодня
    await this.focus.refresh(v).catch(() => undefined);
    const plan = await this.blocks.planDay(v.tenantId, v.userId, { items: created.map((taskId, i) => ({ taskId, minutes: items[i].minutes })) }).catch(() => null) as null | { plan?: { taskId: string; startsAt: string; endsAt: string }[] };
    return { created, proposal: plan?.plan ?? [], day: await this.plus.day(v) };
  }

  /** Принять план первого дня: блоки в календарь + план дня принят. */
  async firstDayAccept(v: Viewer, placements: { taskId: string; startsAt: string; endsAt: string }[]) {
    if (placements.length) await this.blocks.applyPlan(v.tenantId, v.userId, placements.slice(0, 5));
    await this.focus.accept(v).catch(() => undefined);
    return this.plus.day(v);
  }
}
