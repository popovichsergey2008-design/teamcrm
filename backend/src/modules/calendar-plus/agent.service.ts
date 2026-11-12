import { Injectable, OnModuleInit } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { setCalendarAgent } from '../../common/calendar-agent-hook';
import { onWeekLine } from '../../common/week-lines';
import { DbService } from '../../database/db.service';
import { CalendarSeriesService } from '../calendar/calendar-series.service';
import { freeSlots, workWindows, zonedParts, zonedToUtc } from '../calendar/find-time';
import { matchPeople } from '../nl/event-draft';
import { InboxRepository } from '../notifications/inbox.repository';
import { RealtimeService } from '../realtime/realtime.service';
import { parseAgent, partRange } from './agent-rules';
import { bestTime } from './best-time';
import { CalendarPlusService } from './calendar-plus.service';

type Viewer = { userId: string; role: string };
const MIN = 60_000;
const DAY = 86_400_000;

export interface PlanItem {
  kind: 'move' | 'create';
  eventId?: string; title: string;
  fromStartsAt?: string; fromEndsAt?: string;
  startsAt: string; endsAt: string;
  status: string; ok: boolean;
  participantIds?: string[];
}

/**
 * ИИ-агент календаря (#4892, п. 13) и аналитика времени (п. 12).
 * Агент отвечает планом: каждая встреча было → стало, «все свободны» или «Алина занята»,
 * текст для участников. Ничего не меняет без «Применить»; «Отмена» ничего не меняет.
 */
@Injectable()
export class AgentService implements OnModuleInit {
  constructor(
    private readonly db: DbService,
    private readonly plus: CalendarPlusService,
    private readonly series: CalendarSeriesService,
    private readonly inbox: InboxRepository,
    private readonly realtime: RealtimeService,
  ) {}

  onModuleInit(): void {
    // Telegram и QEVO Bot зовут агента через реестр — им не нужна зависимость от календаря
    setCalendarAgent(async (tenantId, user, text) => {
      const r = await this.plan(tenantId, user, text).catch(() => null);
      if (!r || r.kind === 'none') return null;
      const url = `/calendar?agent=${encodeURIComponent(text.slice(0, 300))}`;
      if (r.kind === 'summary') return { text: r.text, url };
      if (!r.items.length) return { text: r.text, url };
      return {
        text: [`План изменений · ${r.items.length}`, ...r.items.map((i) => `${i.title}: ${i.fromStartsAt ? `${this.fmt(i.fromStartsAt, r.tz)} → ` : ''}${this.fmt(i.startsAt, r.tz)} · ${i.status}`),
          r.message ? `Участникам уйдёт: «${r.message}»` : '', 'Применить — в календаре QEVO, ничего не меняется без нажатия.'].filter(Boolean).join('\n'),
        url,
      };
    });
    onWeekLine((tenantId, userId) => this.weekLine(tenantId, userId));
  }

  private fmt(iso: string, tz: string) {
    const ms = Date.parse(iso);
    return `${new Date(ms).toLocaleDateString('ru-RU', { weekday: 'short', timeZone: tz })} ${new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: tz })}`;
  }

  private localNow(tz: string): Date {
    const p = zonedParts(Date.now(), tz);
    return new Date(p.y, p.m - 1, p.d, p.hh, p.mm);
  }

  private at(day: Date, minutes: number, tz: string): number {
    return zonedToUtc(day.getFullYear(), day.getMonth() + 1, day.getDate(), Math.floor(minutes / 60), minutes % 60, tz);
  }

  async plan(tenantId: string, user: Viewer, text: string) {
    const tz = await this.plus.timezoneOf(tenantId, user.userId);
    const intent = parseAgent(text, this.localNow(tz));
    const none = { kind: 'none' as const, tz, text: 'Не понял команду. Например: «перенеси мои встречи завтра после 15:00 на пятницу», «найди час с Глебом на этой неделе», «освободи утро четверга», «что у меня завтра?»', items: [] as PlanItem[], message: null as string | null };
    if (!intent) return none;
    const me = await this.db.one<{ full_name: string }>(`SELECT full_name FROM users WHERE id = $1`, [user.userId]);
    const myName = (me?.full_name ?? '').split(' ')[0] || 'Организатор';

    if (intent.kind === 'summary') {
      const from = this.at(intent.day, 0, tz);
      return { kind: 'summary' as const, tz, items: [] as PlanItem[], message: null, text: await this.daySummary(tenantId, user, from, tz) };
    }

    if (intent.kind === 'find') {
      const users = await this.db.many<{ id: string; name: string }>(
        `SELECT u.id::text, u.full_name AS name FROM users u JOIN roles r ON r.id = u.role_id
          WHERE u.tenant_id = $1 AND u.is_active AND r.code <> 'client' AND u.id <> $2`, [tenantId, user.userId]);
      const ids = matchPeople(text, users).ids;
      if (!ids.length) return { ...none, text: 'С кем найти время? Назовите коллегу по имени: «найди час с Глебом на этой неделе».' };
      const now = this.localNow(tz);
      const endWeek = new Date(now); endWeek.setDate(now.getDate() + (7 - ((now.getDay() + 6) % 7)));
      const notAfter = intent.day ? this.at(intent.day, 24 * 60, tz) : this.at(endWeek, 0, tz);
      const notBefore = intent.day ? this.at(intent.day, 0, tz) : null;
      const r = await this.plus.bestTime(tenantId, user, { participantIds: ids, minutes: intent.minutes, days: 8,
        notBefore: notBefore ? new Date(notBefore).toISOString() : null, notAfter: new Date(notAfter).toISOString() });
      const names = users.filter((u) => ids.includes(u.id)).map((u) => u.name.split(' ')[0]);
      const items: PlanItem[] = r.slots.slice(0, 1).map((s) => ({
        kind: 'create', title: `Встреча с ${names.join(', ')}`, startsAt: s.startsAt, endsAt: s.endsAt,
        status: s.busyOptional.length ? `${s.busyOptional.join(', ')} занят(а)` : (ids.length > 1 ? 'все свободны' : 'свободен'), ok: true, participantIds: ids,
      }));
      return { kind: 'plan' as const, tz, items, message: null, text: items.length ? `Нашёл время: ${r.slots.map((s) => s.label).join(', ')}` : (r.message ?? 'Общего окна нет') };
    }

    // перенос и «освободи»: свои встречи дня по условию
    const dayFrom = this.at(intent.day, 0, tz);
    const rows = await this.db.many<{ id: string; title: string; starts_at: Date; ends_at: Date; owner_id: string }>(
      `SELECT DISTINCT e.id::text, e.title, e.starts_at, e.ends_at, e.owner_id::text FROM calendar_events e
         LEFT JOIN calendar_participants p ON p.event_id = e.id AND p.user_id = $2
        WHERE e.tenant_id = $1 AND NOT e.all_day AND e.starts_at >= $3::timestamptz AND e.starts_at < $4::timestamptz
          AND (e.owner_id = $2 OR (p.user_id IS NOT NULL AND p.status <> 'declined'))
        ORDER BY e.starts_at`,
      [tenantId, user.userId, new Date(Math.max(dayFrom, Date.now())).toISOString(), new Date(dayFrom + DAY).toISOString()]);
    const minuteOf = (d: Date) => { const p = zonedParts(d.getTime(), tz); return p.hh * 60 + p.mm; };
    const pick = rows.filter((r) => {
      const m = minuteOf(r.starts_at);
      if (intent.kind === 'move') {
        if (intent.after != null && m < intent.after) return false;
        if (intent.before != null && m >= intent.before) return false;
        if (intent.part) { const [a, b] = partRange(intent.part); if (m < a || m >= b) return false; }
        return true;
      }
      const [a, b] = partRange(intent.part);
      return m >= a && m < b;
    });
    const items: PlanItem[] = [];
    const notMine: string[] = [];
    for (const r of pick) {
      if (r.owner_id !== String(user.userId)) { notMine.push(r.title); continue; }
      const parts = await this.db.many<{ user_id: string }>(`SELECT user_id::text FROM calendar_participants WHERE event_id = $1 AND status <> 'declined'`, [r.id]);
      const ids = parts.map((p) => p.user_id).filter((x) => x !== String(user.userId));
      const dur = Math.round((r.ends_at.getTime() - r.starts_at.getTime()) / MIN);
      let wantStart: number;
      let notBefore: number; let notAfter: number;
      if (intent.kind === 'move') {
        wantStart = this.at(intent.target, intent.targetMin ?? minuteOf(r.starts_at), tz);
        notBefore = this.at(intent.target, 0, tz); notAfter = notBefore + DAY;
      } else {
        notBefore = this.at(intent.day, 0, tz) + DAY; notAfter = notBefore + 5 * DAY;
        wantStart = notBefore + minuteOf(r.starts_at) * MIN;
      }
      const persons = await this.plus.peopleFor(tenantId, user.userId, [String(user.userId), ...ids], [], wantStart - DAY, wantStart + 6 * DAY, r.id);
      const busy = persons.filter((p) => p.busy.some((b) => b.start < wantStart + dur * MIN && b.end > wantStart));
      let start = wantStart;
      let status = ids.length ? 'все свободны' : 'свободно';
      let ok = true;
      if (busy.length) {
        const res = bestTime({ now: Date.now(), minutes: dur, people: persons, viewerTimeZone: tz, days: 7, limit: 12, notBefore, notAfter, stepMin: 15 });
        const near = [...res.slots].sort((a, b) => Math.abs(Date.parse(a.startsAt) - wantStart) - Math.abs(Date.parse(b.startsAt) - wantStart))[0];
        if (near) start = Date.parse(near.startsAt);
        else { status = `${busy.map((p) => (p.me ? 'вы' : p.name.split(' ')[0])).join(', ')} ${busy.length === 1 && !busy[0].me ? 'занят(а)' : 'заняты'}`; ok = false; }
      }
      items.push({
        kind: 'move', eventId: r.id, title: r.title,
        fromStartsAt: r.starts_at.toISOString(), fromEndsAt: r.ends_at.toISOString(),
        startsAt: new Date(start).toISOString(), endsAt: new Date(start + dur * MIN).toISOString(), status, ok,
      });
    }
    const dayWord = (d: Date) => {
      const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(this.localNow(tz).setHours(0, 0, 0, 0)).getTime()) / DAY);
      return diff === 0 ? 'сегодня' : diff === 1 ? 'завтра' : `в ${d.toLocaleDateString('ru-RU', { weekday: 'long' }).replace(/^./, (x) => x)}`;
    };
    const message = items.length
      ? intent.kind === 'move'
        ? `${myName} не сможет ${dayWord(intent.day)}, предлагаю ${dayWord(intent.target).replace(/^в /, '')}${intent.reason ? ` (${intent.reason})` : ''}`
        : `${myName} освобождает ${dayWord(intent.day)} — встреча переносится${intent.reason ? ` (${intent.reason})` : ''}`
      : null;
    const tail = notMine.length ? ` Не ваши встречи (переносит организатор): ${notMine.join(', ')}.` : '';
    return {
      kind: 'plan' as const, tz, items, message,
      text: items.length ? `План изменений · ${items.length} ${items.length === 1 ? 'встреча' : items.length < 5 ? 'встречи' : 'встреч'}.${tail}` : `Встреч по условию нет.${tail}`,
    };
  }

  /** «Применить»: каждое изменение плана — проверка прав и выполнение; участникам — уведомление и текст. */
  async apply(tenantId: string, user: Viewer, dto: { items: PlanItem[]; message?: string | null }) {
    let done = 0;
    const notify = new Set<string>();
    for (const i of (dto.items ?? []).slice(0, 20)) {
      if (i.kind === 'move' && i.eventId) {
        const ev = await this.db.one<{ owner_id: string }>(`SELECT owner_id::text FROM calendar_events WHERE tenant_id = $1 AND id = $2`, [tenantId, i.eventId]);
        if (!ev || ev.owner_id !== String(user.userId)) throw AppException.forbidden(`«${i.title}» переносит её организатор`);
        await this.series.update(tenantId, user, i.eventId, { startsAt: i.startsAt, endsAt: i.endsAt }, 'one');
        (await this.db.many<{ user_id: string }>(`SELECT user_id::text FROM calendar_participants WHERE event_id = $1 AND user_id <> $2`, [i.eventId, user.userId]))
          .forEach((p) => notify.add(p.user_id));
        done++;
      } else if (i.kind === 'create') {
        await this.plus.createEvent(tenantId, user, { title: i.title, startsAt: i.startsAt, endsAt: i.endsAt, participantIds: i.participantIds ?? [], via: 'agent' });
        done++;
      }
    }
    if (dto.message && notify.size) {
      for (const uid of notify) {
        await this.inbox.record({ tenantId, userId: uid, mailId: null, eventKey: 'calendar.agent', title: 'Встречи перенесены', body: dto.message.slice(0, 500), path: '/calendar' }).catch(() => undefined);
      }
      this.realtime.emitToUsers(tenantId, [...notify], 'calendar.changed', { reason: 'agent' });
    }
    return { applied: done };
  }

  /** «Что у меня завтра?» — встречи, окна и накладки одной сводкой; её можно прослушать. */
  async daySummary(tenantId: string, user: Viewer, dayStart: number, tz: string): Promise<string> {
    const { prefs, input } = await this.plus.weekData(tenantId, user, dayStart, dayStart + DAY);
    const ms = input.meetings.filter((m) => m.start >= dayStart && m.start < dayStart + DAY).sort((a, b) => a.start - b.start);
    const t = (x: number) => new Date(x).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: tz });
    const windows = freeSlots(
      workWindows(dayStart, 1, input.work, tz).map((w) => ({ start: Math.max(w.start, Date.now()), end: w.end })).filter((w) => w.end > w.start),
      [...ms.map((m) => ({ start: m.start, end: m.end })), ...input.blocks.map((b) => ({ start: b.start, end: b.end }))],
    ).filter((w) => w.end - w.start >= 30 * MIN);
    const clash: string[] = [];
    for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) if (ms[j].start < ms[i].end) clash.push(`«${ms[i].title}» и «${ms[j].title}» в ${t(ms[j].start)}`);
    const d = new Date(dayStart).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz });
    void prefs;
    return [
      `${d.replace(/^./, (x) => x.toUpperCase())}: ${ms.length ? `${ms.length} ${ms.length === 1 ? 'встреча' : ms.length < 5 ? 'встречи' : 'встреч'}` : 'встреч нет'}.`,
      ...ms.map((m) => `${t(m.start)}–${t(m.end)} ${m.title}`),
      windows.length ? `Свободные окна: ${windows.slice(0, 4).map((w) => `${t(w.start)}–${t(w.end)}`).join(', ')}.` : 'Свободных окон от получаса нет.',
      clash.length ? `Накладки: ${clash.join('; ')}.` : '',
    ].filter(Boolean).join('\n');
  }

  // ---------- п. 12: аналитика времени ----------

  async myWeek(tenantId: string, user: Viewer, q: { from?: string; to?: string }) {
    const f = q.from ? Date.parse(q.from) : NaN;
    const from = Number.isNaN(f) ? Date.now() - 7 * DAY : f;
    const to = q.to && !Number.isNaN(Date.parse(q.to)) ? Date.parse(q.to) : from + 7 * DAY;
    const { prefs, input } = await this.plus.weekData(tenantId, user, from, to);
    const days = Math.ceil((to - from) / DAY);
    const workMin = Math.round(workWindows(from, days, input.work, prefs.timeZone).filter((w) => w.start < to && w.end > from)
      .reduce((n, w) => n + (w.end - w.start), 0) / MIN);
    const meetingMin = Math.round(input.meetings.reduce((n, m) => n + (m.end - m.start), 0) / MIN);
    const focusMin = Math.round(input.blocks.filter((b) => b.kind === 'focus').reduce((n, b) => n + (b.end - b.start), 0) / MIN);
    const recurring = await this.db.many<{ series_id: string; title: string; n: number; minutes: number; next_id: string | null; owner: boolean }>(
      `SELECT e.series_id::text, min(e.title) AS title, count(*)::int AS n,
              sum(EXTRACT(EPOCH FROM (e.ends_at - e.starts_at)) / 60)::int AS minutes,
              (SELECT x.id::text FROM calendar_events x WHERE x.series_id = e.series_id AND x.starts_at > now() ORDER BY x.starts_at LIMIT 1) AS next_id,
              bool_and(e.owner_id = $2) AS owner
         FROM calendar_events e LEFT JOIN calendar_participants p ON p.event_id = e.id AND p.user_id = $2
        WHERE e.tenant_id = $1 AND e.series_id IS NOT NULL AND e.starts_at < $4::timestamptz AND e.ends_at > $3::timestamptz
          AND (e.owner_id = $2 OR (p.user_id IS NOT NULL AND p.status <> 'declined'))
        GROUP BY e.series_id HAVING sum(EXTRACT(EPOCH FROM (e.ends_at - e.starts_at)) / 60) >= 120
        ORDER BY 4 DESC LIMIT 3`,
      [tenantId, user.userId, new Date(from).toISOString(), new Date(to).toISOString()]);
    const bare = await this.db.many<{ title: string; starts_at: Date }>(
      `SELECT e.title, e.starts_at FROM calendar_events e LEFT JOIN calendar_participants p ON p.event_id = e.id AND p.user_id = $2
        WHERE e.tenant_id = $1 AND NOT e.all_day AND e.ends_at < now() AND e.starts_at >= $3::timestamptz AND e.starts_at < $4::timestamptz
          AND (e.owner_id = $2 OR (p.user_id IS NOT NULL AND p.status <> 'declined'))
          AND (SELECT count(*) FROM calendar_participants x WHERE x.event_id = e.id) >= 2
          AND COALESCE(btrim(e.description), '') = ''
          AND NOT EXISTS (SELECT 1 FROM meeting_agendas a WHERE a.event_id = e.id)
          AND NOT EXISTS (SELECT 1 FROM meetings m WHERE m.event_id = e.id AND m.status = 'done')
        ORDER BY e.starts_at LIMIT 20`,
      [tenantId, user.userId, new Date(from).toISOString(), new Date(to).toISOString()]);
    return {
      meetingMin, focusMin, otherMin: Math.max(0, workMin - meetingMin - focusMin), workMin,
      recurring: recurring.map((r) => ({
        seriesId: r.series_id, title: r.title, weeklyMin: Number(r.minutes), count: Number(r.n), nextEventId: r.next_id, canEdit: !!r.owner,
      })),
      bare: { count: bare.length, days: [...new Set(bare.map((b) => b.starts_at.toLocaleDateString('ru-RU', { weekday: 'short', timeZone: prefs.timeZone })))] },
      bestFocus: await this.bestFocus(tenantId, user, prefs.timeZone, input.work.workStart, input.work.workEnd),
    };
  }

  /** Лучшее время для фокуса: двухчасовое окно рабочего дня с наименьшим числом встреч за 4 недели. */
  private async bestFocus(tenantId: string, user: Viewer, tz: string, ws: string, we: string) {
    const rows = await this.db.many<{ s: number; e: number }>(
      `SELECT (EXTRACT(HOUR FROM e.starts_at AT TIME ZONE $3) * 60 + EXTRACT(MINUTE FROM e.starts_at AT TIME ZONE $3))::int AS s,
              (EXTRACT(HOUR FROM e.ends_at AT TIME ZONE $3) * 60 + EXTRACT(MINUTE FROM e.ends_at AT TIME ZONE $3))::int AS e
         FROM calendar_events e LEFT JOIN calendar_participants p ON p.event_id = e.id AND p.user_id = $2
        WHERE e.tenant_id = $1 AND NOT e.all_day AND e.starts_at > now() - interval '28 days' AND e.starts_at < now()
          AND (e.owner_id = $2 OR (p.user_id IS NOT NULL AND p.status <> 'declined'))`,
      [tenantId, user.userId, tz]);
    const [sh, sm] = ws.split(':').map(Number);
    const [eh, em] = we.split(':').map(Number);
    let best: { a: number; load: number } | null = null;
    for (let a = sh * 60 + (sm || 0); a + 120 <= eh * 60 + (em || 0); a += 60) {
      const load = rows.reduce((n, r) => n + Math.max(0, Math.min(r.e, a + 120) - Math.max(r.s, a)), 0);
      if (!best || load < best.load) best = { a, load };
    }
    if (!best) return null;
    const f = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    return `${f(best.a)}–${f(best.a + 120)}`;
  }

  /** «Сократить до 30 мин?» — следующие встречи серии короче; только организатор. */
  async shorten(tenantId: string, user: Viewer, eventId: string, minutes: number) {
    const ev = await this.db.one<{ starts_at: Date; owner_id: string }>(`SELECT starts_at, owner_id::text FROM calendar_events WHERE tenant_id = $1 AND id = $2`, [tenantId, eventId]);
    if (!ev || ev.owner_id !== String(user.userId)) throw AppException.forbidden('Сокращает организатор встречи');
    const m = Math.max(10, Math.min(240, Math.round(minutes)));
    await this.series.update(tenantId, user, eventId, { endsAt: new Date(ev.starts_at.getTime() + m * MIN).toISOString() }, 'following');
    return { shortened: true };
  }

  /** «Команда» для руководителя: только часы по категориям — без названий и содержания чужих встреч. */
  async team(tenantId: string, user: Viewer, q: { from?: string; to?: string }) {
    if (user.role !== 'owner' && user.role !== 'manager') throw AppException.forbidden('Командная аналитика — для руководителя');
    const f = q.from ? Date.parse(q.from) : NaN;
    const from = Number.isNaN(f) ? Date.now() - 7 * DAY : f;
    const to = q.to && !Number.isNaN(Date.parse(q.to)) ? Date.parse(q.to) : from + 7 * DAY;
    const rows = await this.db.many<{ id: string; name: string; meeting_min: number; focus_min: number }>(
      `SELECT u.id::text, u.full_name AS name,
              COALESCE((SELECT sum(EXTRACT(EPOCH FROM (LEAST(e.ends_at, $3::timestamptz) - GREATEST(e.starts_at, $2::timestamptz))) / 60)
                          FROM calendar_events e LEFT JOIN calendar_participants p ON p.event_id = e.id AND p.user_id = u.id
                         WHERE e.tenant_id = $1 AND NOT e.all_day AND e.starts_at < $3::timestamptz AND e.ends_at > $2::timestamptz
                           AND (e.owner_id = u.id OR (p.user_id IS NOT NULL AND p.status <> 'declined'))), 0)::int AS meeting_min,
              COALESCE((SELECT sum(EXTRACT(EPOCH FROM (LEAST(b.ends_at, $3::timestamptz) - GREATEST(b.starts_at, $2::timestamptz))) / 60)
                          FROM calendar_blocks b WHERE b.user_id = u.id AND b.kind = 'focus'
                           AND b.starts_at < $3::timestamptz AND b.ends_at > $2::timestamptz), 0)::int AS focus_min
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.tenant_id = $1 AND u.is_active AND r.code <> 'client'
        ORDER BY u.full_name LIMIT 100`,
      [tenantId, new Date(from).toISOString(), new Date(to).toISOString()]);
    return rows.map((r) => ({ userId: r.id, name: r.name, meetingMin: Number(r.meeting_min), focusMin: Number(r.focus_min) }));
  }

  /** Строка в пятничный итог недели — вместе с итогами дня и Фокуса (п. 12). */
  private async weekLine(tenantId: string, userId: string): Promise<string | null> {
    const role = await this.db.one<{ code: string }>(`SELECT r.code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [userId]);
    const w = await this.myWeek(tenantId, { userId, role: role?.code ?? 'member' }, { from: new Date(Date.now() - 5 * DAY).toISOString(), to: new Date().toISOString() });
    const h = (m: number) => `${Math.round(m / 6) / 10} ч`.replace('.', ',');
    const parts = [`Календарь: ${h(w.meetingMin)} встреч · ${h(w.focusMin)} фокуса · ${h(w.otherMin)} на остальное`];
    if (w.recurring[0]) parts.push(`самая «дорогая» регулярная — «${w.recurring[0].title}», ${h(w.recurring[0].weeklyMin)} в неделю`);
    if (w.bare.count) parts.push(`без повестки и итогов: ${w.bare.count}`);
    if (w.bestFocus) parts.push(`лучшее время для фокуса ${w.bestFocus}`);
    return parts.join(' · ');
  }
}
