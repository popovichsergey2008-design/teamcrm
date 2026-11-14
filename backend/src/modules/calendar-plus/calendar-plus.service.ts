import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { plural } from '../../common/text/ru-grammar';
import { DbService } from '../../database/db.service';
import { CalendarBlocksService } from '../calendar/calendar-blocks.service';
import { CalendarCardService } from '../calendar/calendar-card.service';
import { CalendarSeriesService } from '../calendar/calendar-series.service';
import { CalendarService } from '../calendar/calendar.service';
import { zonedParts, zonedToUtc } from '../calendar/find-time';
import { bufferChanges, candidates, Candidate, Meeting, weekInsight } from './assistant-rules';
import { bestTime, BusySpan, dayBar, Person, zoneLabel } from './best-time';
import { CalendarPlusRepository, type CallRow, PrefsRow } from './calendar-plus.repository';
import { phraseDraft, RepeatFreq } from './phrase-rules';

type Viewer = { userId: string; role: string };
const MIN = 60_000;
const DAY = 86_400_000;

const fmtDay = (ms: number, tz: string, now: number) => {
  const d = zonedParts(ms, tz).date;
  const today = zonedParts(now, tz).date;
  const tomorrow = zonedParts(now + DAY, tz).date;
  const time = new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: tz });
  if (d === today) return `сегодня ${time}`;
  if (d === tomorrow) return `завтра ${time}`;
  return `${new Date(ms).toLocaleDateString('ru-RU', { weekday: 'short', timeZone: tz })} ${time}`;
};
const hours = (min: number) => (min % 60 ? `${Math.floor(min / 60)} ч ${min % 60} мин` : `${min / 60} ч`).replace(/^0 ч /, '');
const stopWords = new Set(['созвон', 'встреча', 'встречу', 'звонок', 'планерка', 'планёрка', 'обсуждение', 'для', 'про', 'по', 'и', 'с', 'на', 'в', 'клиента', 'клиентом']);
export const topicWords = (title: string) => title.toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я0-9]+/i)
  .filter((w) => w.length >= 3 && !stopWords.has(w)).slice(0, 5);

/**
 * Календарь #4892: личные часы и обед, карточка недели и «Ассистент недели», лучшее
 * время с причинами, событие одной фразой, созвоны в сетке. Главное правило ТЗ:
 * ничего не создаётся и не переносится без нажатия «Применить» — здесь только
 * расчёты и действия по явной команде человека.
 */
@Injectable()
export class CalendarPlusService {
  constructor(
    private readonly db: DbService,
    private readonly repo: CalendarPlusRepository,
    private readonly calendar: CalendarService,
    private readonly series: CalendarSeriesService,
    private readonly blocks: CalendarBlocksService,
    private readonly card: CalendarCardService,
  ) {}

  // ---------- настройки ----------

  async prefs(tenantId: string, userId: string) {
    const [p, work, tz, links, google] = await Promise.all([
      this.repo.prefs(tenantId, userId),
      this.calendar.work(tenantId),
      this.timezoneOf(tenantId, userId),
      this.db.many<{ kind: string }>(`SELECT kind FROM calendar_links WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]),
      this.db.one<{ ok: boolean }>(`SELECT TRUE AS ok FROM google_calendar_settings WHERE user_id = $1`, [userId]),
    ]);
    const kinds = new Set(links.map((l) => l.kind));
    const connected = { google: !!google || kinds.has('google'), yandex: kinds.has('yandex'), ics: kinds.has('import') };
    return {
      workStart: p?.work_start ?? work.workStart,
      workEnd: p?.work_end ?? work.workEnd,
      lunchStart: p?.lunch_start ?? null,
      lunchEnd: p?.lunch_end ?? null,
      ownHours: !!p?.work_start,
      timeZone: tz,
      focusGoalMin: p?.focus_goal_min ?? 0,
      chatSuggest: p?.chat_suggest ?? true,
      prepMin: p?.prep_min ?? 10,
      onboarded: !!p?.onboarded_at,
      dismissed: p?.dismissed ?? [],
      connected: { ...connected, any: connected.google || connected.yandex || connected.ics },
      company: { workStart: work.workStart, workEnd: work.workEnd, weekendDays: work.weekendDays },
    };
  }

  async savePrefs(tenantId: string, userId: string, dto: {
    workStart?: string | null; workEnd?: string | null; lunchStart?: string | null; lunchEnd?: string | null;
    timeZone?: string; focusGoalMin?: number; chatSuggest?: boolean; prepMin?: number; onboarded?: boolean;
  }) {
    const t = (v: string | null | undefined) => (v === undefined ? undefined : v && /^\d{2}:\d{2}$/.test(v) ? v : null);
    const ws = t(dto.workStart);
    const we = t(dto.workEnd);
    if (ws && we && ws >= we) throw AppException.validation('Начало рабочего дня должно быть раньше конца');
    const ls = t(dto.lunchStart);
    const le = t(dto.lunchEnd);
    if (ls && le && ls >= le) throw AppException.validation('Обед должен начинаться раньше, чем заканчиваться');
    if (dto.timeZone !== undefined) {
      try { new Intl.DateTimeFormat('ru-RU', { timeZone: dto.timeZone }); } catch { throw AppException.validation('Неизвестный часовой пояс'); }
      await this.db.query(`UPDATE users SET timezone = $3 WHERE tenant_id = $1 AND id = $2`, [tenantId, userId, dto.timeZone]);
    }
    await this.repo.savePrefs(tenantId, userId, {
      work_start: ws, work_end: we, lunch_start: ls, lunch_end: le,
      focus_goal_min: dto.focusGoalMin === undefined ? undefined : Math.max(0, Math.min(40 * 60, Math.round(dto.focusGoalMin))),
      chat_suggest: dto.chatSuggest,
      prep_min: dto.prepMin === undefined ? undefined : Math.max(0, Math.min(120, Math.round(dto.prepMin))),
      onboarded: dto.onboarded,
    });
    return this.prefs(tenantId, userId);
  }

  async timezoneOf(tenantId: string, userId: string): Promise<string> {
    const r = await this.db.one<{ tz: string | null }>(
      `SELECT COALESCE(u.timezone, t.timezone) AS tz FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1 AND u.tenant_id = $2`,
      [userId, tenantId]);
    return r?.tz || 'Europe/Moscow';
  }

  // ---------- люди для подбора ----------

  /** Участники с их часами, обедом, поясом и занятостью — вход для bestTime. */
  async peopleFor(tenantId: string, meId: string, ids: string[], optionalIds: string[], from: number, to: number, exceptEventId?: string | null): Promise<Person[]> {
    const all = [...new Set([...ids, ...optionalIds].map(String))].slice(0, 30);
    const [rows, prefs, work, busy] = await Promise.all([
      this.repo.people(tenantId, all),
      this.repo.prefsOf(tenantId, all),
      this.calendar.work(tenantId),
      this.repo.busyOfPeople(tenantId, all, meId, new Date(from).toISOString(), new Date(to).toISOString(), exceptEventId),
    ]);
    const pref = new Map(prefs.map((p) => [String(p.user_id), p]));
    const opt = new Set(optionalIds.map(String).filter((x) => !ids.map(String).includes(x)));
    return rows.map((u) => {
      const p = pref.get(u.id);
      return {
        id: u.id, name: u.full_name, timeZone: u.tz,
        workStart: p?.work_start ?? work.workStart, workEnd: p?.work_end ?? work.workEnd,
        lunchStart: p?.lunch_start ?? null, lunchEnd: p?.lunch_end ?? null,
        weekendDays: work.weekendDays, holidays: work.holidays,
        busy: busy.filter((b) => b.user_id === u.id).map((b) => ({ start: b.starts_at.getTime(), end: b.ends_at.getTime(), kind: b.kind, title: b.title })),
        optional: opt.has(u.id), me: u.id === String(meId),
      };
    });
  }

  /** «Найти время» (п. 4): три слота с причинами и полосы занятости дня лучшего слота. */
  async bestTime(tenantId: string, user: Viewer, dto: { participantIds: string[]; optionalIds?: string[]; minutes: number; exceptEventId?: string | null; notBefore?: string | null; notAfter?: string | null; days?: number }) {
    const now = Date.now();
    const days = Math.max(1, Math.min(21, dto.days ?? 10));
    const req = [...new Set([String(user.userId), ...(dto.participantIds ?? []).map(String)])];
    const opt = (dto.optionalIds ?? []).map(String).filter((x) => !req.includes(x));
    const viewerTz = await this.timezoneOf(tenantId, user.userId);
    const people = await this.peopleFor(tenantId, user.userId, req, opt, now - DAY, now + (days + 1) * DAY, dto.exceptEventId);
    const nb = dto.notBefore ? Date.parse(dto.notBefore) : NaN;
    const na = dto.notAfter ? Date.parse(dto.notAfter) : NaN;
    const res = bestTime({
      now, minutes: dto.minutes, people, viewerTimeZone: viewerTz, days, limit: 3,
      notBefore: Number.isNaN(nb) ? null : nb, notAfter: Number.isNaN(na) ? null : na,
    });
    const anchor = res.slots[0] ? Date.parse(res.slots[0].startsAt) : now + DAY;
    const me = people.find((p) => p.me);
    const d = zonedParts(anchor, viewerTz);
    const ws = (me?.workStart ?? '09:00').split(':').map(Number);
    const we = (me?.workEnd ?? '18:00').split(':').map(Number);
    const window = { start: zonedToUtc(d.y, d.m, d.d, ws[0], ws[1] || 0, viewerTz), end: zonedToUtc(d.y, d.m, d.d, we[0], we[1] || 0, viewerTz) };
    const order = (p: Person) => (p.me ? 0 : p.optional ? 2 : 1);
    return {
      minutes: dto.minutes, timeZone: viewerTz, message: res.message,
      slots: res.slots.map((s) => ({ ...s, label: fmtDay(Date.parse(s.startsAt), viewerTz, now) })),
      day: { startsAt: new Date(window.start).toISOString(), endsAt: new Date(window.end).toISOString(), label: fmtDay(window.start, viewerTz, now).replace(/ \d\d:\d\d$/, '') },
      people: [...people].sort((a, b) => order(a) - order(b)).map((p) => ({
        id: p.id, name: p.me ? 'Вы' : p.name, me: !!p.me, optional: !!p.optional,
        zone: zoneLabel(p.timeZone, viewerTz, anchor),
        bar: dayBar(p, anchor, window).map((b) => ({ kind: b.kind, startsAt: new Date(b.start).toISOString(), endsAt: new Date(b.end).toISOString() })),
      })),
    };
  }

  // ---------- событие одной фразой ----------

  /** Местное «YYYY-MM-DDTHH:mm» клиента → момент UTC по его смещению. */
  private static utcOf(local: string | null, offsetMin: number): number | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local ?? '');
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) + offsetMin * MIN;
  }

  async phrasePreview(tenantId: string, user: Viewer, dto: { text: string; now?: string; offset?: number }) {
    const text = (dto.text ?? '').trim();
    if (text.length < 3) throw AppException.validation('Опишите событие');
    const offset = Number.isFinite(dto.offset) ? Number(dto.offset) : -180;
    const nowLocal = new Date(Date.now() - offset * MIN);
    const now = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(dto.now ?? '')
      ? new Date(Number(dto.now!.slice(0, 4)), Number(dto.now!.slice(5, 7)) - 1, Number(dto.now!.slice(8, 10)), Number(dto.now!.slice(11, 13)), Number(dto.now!.slice(14, 16)))
      : new Date(nowLocal.getUTCFullYear(), nowLocal.getUTCMonth(), nowLocal.getUTCDate(), nowLocal.getUTCHours(), nowLocal.getUTCMinutes());
    const [users, prefs] = await Promise.all([
      this.db.many<{ id: string; name: string }>(
        `SELECT u.id::text, u.full_name AS name FROM users u JOIN roles r ON r.id = u.role_id
          WHERE u.tenant_id = $1 AND u.is_active AND r.code <> 'client' AND u.id <> $2 ORDER BY u.full_name`,
        [tenantId, user.userId]),
      this.prefs(tenantId, user.userId),
    ]);
    const d = phraseDraft(text, now, users, { lunchEnd: prefs.lunchEnd, workStart: prefs.workStart });
    const start = CalendarPlusService.utcOf(d.startsAt, offset);
    const end = CalendarPlusService.utcOf(d.endsAt, offset);
    const people = users.filter((u) => d.participantIds.includes(u.id));
    let busyNames: string[] = [];
    let suggestion: { startsAt: string; endsAt: string; label: string } | null = null;
    if (start && end && !d.allDay) {
      const ids = [String(user.userId), ...people.map((p) => p.id)];
      const persons = await this.peopleFor(tenantId, user.userId, ids, [], start - DAY, end + 2 * DAY);
      const span = { start, end };
      busyNames = persons.filter((p) => p.busy.some((b) => b.start < span.end && b.end > span.start)).map((p) => (p.me ? 'у вас' : `у ${p.name.split(' ')[0]}`));
      if (busyNames.length) {
        const viewerTz = await this.timezoneOf(tenantId, user.userId);
        const dd = zonedParts(start, viewerTz);
        const dayStart = zonedToUtc(dd.y, dd.m, dd.d, 0, 0, viewerTz);
        const r = bestTime({
          now: Date.now(), minutes: Math.round((end - start) / MIN), people: persons, viewerTimeZone: viewerTz,
          days: 2, limit: 12, notBefore: Math.max(Date.now(), dayStart), notAfter: dayStart + DAY, stepMin: 15,
        });
        const near = [...r.slots].sort((a, b) => Math.abs(Date.parse(a.startsAt) - start) - Math.abs(Date.parse(b.startsAt) - start))[0];
        if (near) suggestion = { startsAt: near.startsAt, endsAt: near.endsAt, label: new Date(near.startsAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: viewerTz }) };
      }
    }
    const words = topicWords(d.topic ?? d.title);
    const agenda = await this.repo.tasksByTopic(tenantId, user.userId, user.role === 'owner' || user.role === 'manager', words,
      [String(user.userId), ...people.map((p) => p.id)], 5);
    return {
      title: d.title, topic: d.topic, allDay: d.allDay, location: d.location, repeat: d.repeat, timeGuessed: d.timeGuessed,
      startsAt: start ? new Date(start).toISOString() : null,
      endsAt: end ? new Date(end).toISOString() : null,
      people: people.map((p) => ({ id: p.id, name: p.name })),
      allFree: !!start && !busyNames.length,
      busy: busyNames,
      suggestion,
      call: people.length > 0,
      agenda: agenda.map((t) => ({ id: t.id, title: t.title, projectId: t.project_id, overdueDays: t.overdue_days })),
    };
  }

  /** Повестка правилами: «1. Доступы к CRM — #1326 (просрочено 33 дн.)» … «Кто и к какому сроку». */
  static agendaFromTasks(tasks: { id: string; title: string; overdueDays?: number | null; overdue_days?: number | null }[]): string {
    const lines = tasks.slice(0, 5).map((t, i) => {
      const od = t.overdueDays ?? t.overdue_days;
      return `${i + 1}. ${t.title} — #${t.id}${od ? ` (просрочено ${od} дн.)` : ''}`;
    });
    if (lines.length) lines.push(`${lines.length + 1}. Кто и к какому сроку`);
    return lines.join('\n');
  }

  /**
   * Создать встречу по явной кнопке («Создать и пригласить», «Выбрать» в «Найти время»,
   * «Назначить» в чате): созвон со ссылкой, повестка сразу, задачи темы — к встрече.
   */
  async createEvent(tenantId: string, user: Viewer, dto: {
    title: string; startsAt: string; endsAt: string; participantIds?: string[]; description?: string | null;
    repeat?: RepeatFreq | null; via: string; agendaTaskIds?: string[]; allDay?: boolean; location?: string | null;
  }) {
    const ids = (dto.participantIds ?? []).map(String).filter((x) => x !== String(user.userId));
    const tasks = dto.agendaTaskIds?.length
      ? await this.db.many<{ id: string; title: string; overdue_days: number | null }>(
        `SELECT id::text, title, CASE WHEN deadline_at < now() THEN floor(EXTRACT(EPOCH FROM now() - deadline_at) / 86400)::int END AS overdue_days
           FROM tasks WHERE tenant_id = $1 AND id = ANY($2::bigint[]) AND deleted_at IS NULL`, [tenantId, dto.agendaTaskIds.slice(0, 5)])
      : [];
    const agenda = CalendarPlusService.agendaFromTasks(tasks);
    const ev = await this.series.create(tenantId, user, {
      title: dto.title.trim().slice(0, 255) || 'Встреча',
      description: dto.description?.trim() || undefined,
      location: dto.location ?? undefined,
      startsAt: dto.startsAt, endsAt: dto.endsAt, allDay: !!dto.allDay,
      participantIds: ids, isCall: ids.length > 0 && !dto.allDay, scope: 'personal',
      repeat: dto.repeat ? { freq: dto.repeat, until: null } : null,
    }) as { id: string; startsAt: string | Date };
    const id = String(ev.id);
    await this.repo.setCreatedVia(tenantId, id, dto.via);
    for (const t of tasks) await this.card.link(tenantId, user, id, t.id).catch(() => undefined);
    if (agenda) await this.repo.saveAgenda(tenantId, id, new Date(ev.startsAt), agenda, tasks.map((t) => ({ kind: 'task', id: t.id })), null);
    return this.calendar.details(tenantId, user, id);
  }

  // ---------- неделя и ассистент ----------

  private async weekInput(tenantId: string, user: Viewer, from: number, to: number) {
    const now = Date.now();
    const [prefs, rows, blockRows, tasks, calls] = await Promise.all([
      this.prefs(tenantId, user.userId),
      this.repo.myMeetings(tenantId, user.userId, new Date(from).toISOString(), new Date(to).toISOString()),
      this.blocks.inRange(tenantId, user.userId, new Date(from).toISOString(), new Date(to).toISOString()),
      this.repo.myOpenTasks(tenantId, user.userId, new Date(to + DAY).toISOString()),
      // #4920, п. 1: созвоны QEVO — тоже встречи: в шапке, ассистенте, аналитике и подборе
      this.repo.callsInRange(tenantId, user.userId, new Date(from).toISOString(), new Date(to).toISOString()),
    ]);
    const external = await this.db.many<{ id: string; title: string; starts_at: Date; ends_at: Date }>(
      `SELECT x.id::text, x.title, x.starts_at, x.ends_at FROM calendar_external_events x JOIN calendar_links l ON l.id = x.link_id
        WHERE x.tenant_id = $1 AND l.user_id = $2 AND NOT x.all_day AND x.starts_at < $4::timestamptz AND x.ends_at > $3::timestamptz`,
      [tenantId, user.userId, new Date(from).toISOString(), new Date(to).toISOString()]);
    const meetings: Meeting[] = [
      ...rows.map((r) => ({
        id: r.id, title: r.title, start: r.starts_at.getTime(), end: r.ends_at.getTime(),
        mine: String(r.owner_id) === String(user.userId), participants: Number(r.participants) || 1, hasAgenda: !!r.has_agenda,
      })),
      ...external.map((x) => ({ id: `x${x.id}`, title: x.title, start: x.starts_at.getTime(), end: x.ends_at.getTime(), mine: false, participants: 1, hasAgenda: true, external: true })),
      // созвон уже прошёл или идёт: двигать и готовить повестку нечего — только время
      ...calls.map((c) => ({
        id: `call${c.id}`, title: CalendarPlusService.callTitle(c), start: c.started_at.getTime(),
        end: (c.ended_at ?? new Date(Math.max(now, c.started_at.getTime() + 15 * MIN))).getTime(),
        mine: false, participants: Number(c.participants) || 1, hasAgenda: true, external: true,
      })),
    ];
    return {
      prefs,
      input: {
        now, from, to, timeZone: prefs.timeZone,
        work: { workStart: prefs.workStart, workEnd: prefs.workEnd, weekendDays: prefs.company.weekendDays, holidays: [] as string[] },
        lunch: prefs.lunchStart && prefs.lunchEnd ? { start: prefs.lunchStart, end: prefs.lunchEnd } : null,
        meetings,
        blocks: (blockRows as { id: string; kind: 'task' | 'focus'; startsAt: string; endsAt: string }[])
          .map((b) => ({ id: b.id, kind: b.kind, start: Date.parse(b.startsAt), end: Date.parse(b.endsAt) })),
        tasks: tasks.map((t) => ({ id: t.id, title: t.title, deadline: t.deadline_at.getTime(), estimateMin: t.estimate_hours ? Math.round(Number(t.estimate_hours) * 60) : null, planned: t.planned })),
      },
    };
  }

  private static weekBounds(from?: string, to?: string) {
    const f = from ? Date.parse(from) : NaN;
    const t = to ? Date.parse(to) : NaN;
    if (!Number.isNaN(f) && !Number.isNaN(t) && t > f && t - f <= 15 * DAY) return { from: f, to: t };
    const now = Date.now();
    return { from: now - DAY, to: now + 7 * DAY };
  }

  /** Подсказки недели: до четырёх, по важности, у каждой одна кнопка и предпросмотр. */
  async assistant(tenantId: string, user: Viewer, q: { from?: string; to?: string }) {
    const { from, to } = CalendarPlusService.weekBounds(q.from, q.to);
    const { prefs, input } = await this.weekInput(tenantId, user, from, to);
    const insight = weekInsight(input);
    const all = candidates(input, insight).filter((c) => !prefs.dismissed.includes(c.kind) && !prefs.dismissed.includes(c.key));
    const suggestions = [];
    for (const c of all) {
      if (suggestions.length >= 4) break;
      const s = await this.describe(tenantId, user, c, prefs.timeZone).catch(() => null);
      if (s) suggestions.push(s);
    }
    return {
      insight: {
        meetingMin: insight.meetingMin, workMin: insight.workMin,
        meetingText: `${hours(insight.meetingMin)} встреч из ${Math.round(insight.workMin / 60)}`,
        overlaps: insight.overlaps.length,
        backToBack: insight.backToBack.length,
        focusWindows: insight.focusWindows.length,
        windows: insight.focusWindows.slice(0, 6).map((w) => ({ startsAt: new Date(w.start).toISOString(), endsAt: new Date(w.end).toISOString() })),
      },
      suggestions,
    };
  }

  /** Текст подсказки и её предпросмотр: что изменится — было → стало. */
  private async describe(tenantId: string, user: Viewer, c: Candidate, tz: string) {
    const now = Date.now();
    const t = (ms: number) => fmtDay(ms, tz, now);
    const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: tz });
    const short = (s: string) => (s.length > 40 ? `${s.slice(0, 38)}…` : s);
    if ((c.kind === 'overlap' || c.kind === 'heavy_day') && c.meeting) {
      const m = c.meeting;
      const movable = m.mine && !m.external;
      if (!movable) {
        return {
          key: c.key, kind: c.kind, tone: 'danger',
          title: `Накладка ${t(m.start)}`,
          text: `«${short(c.other?.title ?? '')}» и «${short(m.title)}». Встречу «${short(m.title)}» назначили не вы — можно отказаться от неё.`,
          action: { label: 'Отказаться', kind: 'decline' },
          preview: [{ label: m.title, before: `${t(m.start)}`, after: 'вы отказались — организатор увидит' }],
        };
      }
      const parts = await this.db.many<{ user_id: string }>(
        `SELECT user_id::text FROM calendar_participants WHERE event_id = $1 AND status <> 'declined'`, [m.id]);
      const dur = Math.round((m.end - m.start) / MIN);
      const res = await this.bestTime(tenantId, user, {
        participantIds: parts.map((p) => p.user_id), minutes: dur, exceptEventId: m.id, days: 7,
        notBefore: c.kind === 'heavy_day' ? new Date(zonedToUtc(...(() => { const d = zonedParts(m.start + DAY, tz); return [d.y, d.m, d.d, 0, 0] as const; })(), tz)).toISOString() : null,
      });
      const slot = res.slots[0];
      if (!slot) return null;
      const free = parts.length > 1 ? 'все свободны' : 'вы свободны';
      return c.kind === 'overlap'
        ? {
          key: c.key, kind: c.kind, tone: 'danger',
          title: `Накладка ${t(Math.max(m.start, c.other?.start ?? m.start))}`,
          text: `«${short(c.other?.title ?? '')}» и «${short(m.title)}». Перенести «${short(m.title)}» на ${slot.label} — ${free}`,
          action: { label: 'Перенести', kind: 'move' },
          preview: [{ label: m.title, before: t(m.start), after: `${slot.label} · ${free}` }],
          slot: { startsAt: slot.startsAt, endsAt: slot.endsAt },
        }
        : {
          key: c.key, kind: c.kind, tone: 'warn',
          title: `${t(m.start).split(' ')[0].replace(/^./, (x) => x.toUpperCase())}: ${c.dayMeetings} встреч, больше 5 ч`,
          text: `День перегружен встречами. Перенести «${short(m.title)}» на ${slot.label} — ${free}?`,
          action: { label: 'Перенести', kind: 'move' },
          preview: [{ label: m.title, before: t(m.start), after: `${slot.label} · ${free}` }],
          slot: { startsAt: slot.startsAt, endsAt: slot.endsAt },
        };
    }
    if (c.kind === 'buffers' && c.chain) {
      const ch = bufferChanges(c.chain);
      if (!ch.length) return null;
      const day = t(c.chain[0].start).split(' ')[0];
      return {
        key: c.key, kind: c.kind, tone: 'warn',
        title: `${day.replace(/^./, (x) => x.toUpperCase())}: ${c.dayMeetings} ${plural(c.dayMeetings ?? 0, 'встреча', 'встречи', 'встреч')} за день`,
        text: `с ${hhmm(c.chain[0].start)} до ${hhmm(c.chain[c.chain.length - 1].end)} — ${c.chain.length} подряд без перерыва. Добавить 10 мин между встречами?`,
        action: { label: 'Добавить буферы', kind: 'buffers' },
        preview: ch.map((x) => ({ label: x.title, before: `${hhmm(x.start)}–${hhmm(x.end)}`, after: `${hhmm(x.start)}–${hhmm(x.newEnd)}` })),
      };
    }
    if (c.kind === 'focus_window' && c.task && c.window) {
      const dl = new Date(c.task.deadline).toLocaleDateString('ru-RU', { weekday: 'short', timeZone: tz });
      return {
        key: c.key, kind: c.kind, tone: 'ok',
        title: `${t(c.window.start).replace(/^./, (x) => x.toUpperCase())}–${hhmm(c.window.end)} свободно`,
        text: `лучшее окно для «${short(c.task.title)}» (срок ${dl})`,
        action: { label: 'Поставить фокус', kind: 'focus' },
        preview: [{ label: `Фокус · ${c.task.title}`, before: 'не запланировано', after: `${t(c.window.start)}–${hhmm(c.window.end)}` }],
        window: { startsAt: new Date(c.window.start).toISOString(), endsAt: new Date(c.window.end).toISOString() },
      };
    }
    if (c.kind === 'agenda' && c.meeting) {
      const words = topicWords(c.meeting.title);
      const tasks = await this.repo.tasksByTopic(tenantId, user.userId, user.role === 'owner' || user.role === 'manager', words, [], 5);
      const body = CalendarPlusService.agendaFromTasks(tasks) || `1. Цель встречи «${c.meeting.title}»\n2. Что мешает\n3. Кто и к какому сроку`;
      return {
        key: c.key, kind: c.kind, tone: 'plain',
        title: 'Встреча без повестки',
        text: `«${short(c.meeting.title)}» ${t(c.meeting.start).split(' ')[0]} — собрать повестку из задач?`,
        action: { label: 'Собрать', kind: 'agenda' },
        preview: body.split('\n').map((line) => ({ label: line, before: '', after: '' })),
      };
    }
    return null;
  }

  /** «Применить»: подсказка пересчитывается на сервере и выполняется ровно она. */
  async applySuggestion(tenantId: string, user: Viewer, dto: { key: string; from?: string; to?: string }) {
    const { from, to } = CalendarPlusService.weekBounds(dto.from, dto.to);
    const { prefs, input } = await this.weekInput(tenantId, user, from, to);
    const c = candidates(input, weekInsight(input)).find((x) => x.key === dto.key);
    if (!c) throw AppException.conflict('Подсказка уже неактуальна — календарь изменился');
    const s = await this.describe(tenantId, user, c, prefs.timeZone) as ({ slot?: { startsAt: string; endsAt: string }; action: { kind: string } } | null);
    if (!s) throw AppException.conflict('Подсказка уже неактуальна');
    if (s.action.kind === 'move' && c.meeting && s.slot) {
      await this.series.update(tenantId, user, c.meeting.id, { startsAt: s.slot.startsAt, endsAt: s.slot.endsAt }, 'one');
    } else if (s.action.kind === 'decline' && c.meeting) {
      await this.calendar.respond(tenantId, user.userId, c.meeting.id, 'declined');
    } else if (s.action.kind === 'buffers' && c.chain) {
      for (const ch of bufferChanges(c.chain)) {
        await this.series.update(tenantId, user, ch.id, { endsAt: new Date(ch.newEnd).toISOString() }, 'one');
      }
    } else if (s.action.kind === 'focus' && c.task && c.window) {
      await this.blocks.create(tenantId, user.userId, {
        kind: 'focus', taskIds: [c.task.id], title: `Фокус · ${c.task.title}`.slice(0, 300),
        startsAt: new Date(c.window.start).toISOString(), endsAt: new Date(c.window.end).toISOString(),
      });
    } else if (s.action.kind === 'agenda' && c.meeting) {
      const tasks = await this.repo.tasksByTopic(tenantId, user.userId, user.role === 'owner' || user.role === 'manager', topicWords(c.meeting.title), [], 5);
      const body = CalendarPlusService.agendaFromTasks(tasks) || `1. Цель встречи «${c.meeting.title}»\n2. Что мешает\n3. Кто и к какому сроку`;
      await this.repo.saveAgenda(tenantId, c.meeting.id, new Date(c.meeting.start), body, tasks.map((t) => ({ kind: 'task', id: t.id })), user.userId);
      for (const t of tasks) await this.card.link(tenantId, user, c.meeting.id, t.id).catch(() => undefined);
    }
    return { applied: dto.key };
  }

  async dismiss(tenantId: string, userId: string, key: string) {
    await this.repo.dismiss(tenantId, userId, key);
    return { dismissed: key };
  }

  // ---------- созвоны в сетке ----------

  /**
   * #4920, п. 4: в сетке — тема, а не безликое «Созвон». Тема — название разбора (его даёт
   * ИИ по разговору), пока его нет — группа, из которой звонили, или с кем говорили.
   * «Созвон 13.11, 08:49» — заглушка до разбора, темой не считается.
   */
  static callTitle(r: Pick<CallRow, 'meeting_title' | 'chat_title' | 'others'>): string {
    const topic = r.meeting_title?.trim();
    if (topic && !/^Созвон \d{2}\.\d{2}/.test(topic)) return topic;
    if (r.chat_title?.trim()) return `Созвон · ${r.chat_title.trim()}`;
    const others = (r.others ?? '').split(', ').filter(Boolean).map((n) => n.split(' ')[0]);
    return others.length ? `Созвон с ${others.slice(0, 3).join(', ')}${others.length > 3 ? ` и ещё ${others.length - 3}` : ''}` : 'Созвон';
  }

  async calls(tenantId: string, userId: string, from: string, to: string) {
    const rows = await this.repo.callsInRange(tenantId, userId, from, to);
    return rows.map((r) => ({
      id: `call${r.id}`,
      title: CalendarPlusService.callTitle(r),
      startsAt: r.started_at.toISOString(),
      endsAt: (r.ended_at ?? new Date(Math.max(Date.now(), r.started_at.getTime() + 15 * MIN))).toISOString(),
      live: !r.ended_at,
      chatId: r.chat_id, roomId: r.room_id, participants: Number(r.participants) || 0,
      meetingId: r.meeting_id, summaryReady: r.meeting_status === 'done',
    }));
  }

  /**
   * Карточка созвона (#4920, п. 4; п. 6 ТЗ #4892): что за встреча, «Войти в звонок», пока
   * идёт, итоги и задачи по людям, что договорились в прошлый раз, материалы из чата.
   * Раньше щелчок по созвону уводил в общий список встреч.
   */
  async callCard(tenantId: string, userId: string, id: string) {
    const callId = String(id).replace(/^call/, '');
    if (!/^\d+$/.test(callId)) throw AppException.notFound('Созвон не найден');
    const c = await this.repo.callOf(tenantId, userId, callId);
    if (!c) throw AppException.notFound('Созвон не найден');
    const end = c.ended_at ?? new Date();
    const [summary, tasks, prev, files] = await Promise.all([
      c.meeting_id && c.meeting_status === 'done' ? this.repo.meetingSummary(tenantId, c.meeting_id) : Promise.resolve(null),
      c.meeting_id ? this.repo.meetingAgreements(tenantId, c.meeting_id) : Promise.resolve([]),
      this.repo.previousCallMeeting(tenantId, c),
      c.chat_id ? this.repo.chatFiles(tenantId, c.chat_id, end) : Promise.resolve([]),
    ]);
    const agreements = prev ? await this.repo.meetingAgreements(tenantId, prev.meeting_id) : [];
    const decisions = Array.isArray(summary?.decisions) ? (summary!.decisions as unknown[]).map(String).filter(Boolean).slice(0, 8) : [];
    const task = (t: { title: string; assignee: string | null; deadline_at: Date | null; task_id: string | null; done: boolean; project_id: string | null }) => ({
      title: t.title, assignee: t.assignee, deadlineAt: t.deadline_at?.toISOString() ?? null, taskId: t.task_id, projectId: t.project_id, done: !!t.done,
    });
    return {
      id: `call${c.id}`, title: CalendarPlusService.callTitle(c),
      startsAt: c.started_at.toISOString(), endsAt: end.toISOString(), live: !c.ended_at,
      roomId: c.room_id, chatId: c.chat_id, chatTitle: c.chat_title,
      people: (c.others ?? '').split(', ').filter(Boolean),
      meeting: c.meeting_id ? {
        id: c.meeting_id, status: c.meeting_status,
        summary: summary?.summary?.trim() || null, decisions, tasks: tasks.map(task),
      } : null,
      previous: prev ? { meetingId: prev.meeting_id, title: prev.title, happenedAt: prev.happened_at.toISOString(), agreements: agreements.map(task) } : null,
      materials: files.map((f) => ({ fileId: f.file_id, title: f.file_name })),
    };
  }

  // ---------- аналитика времени ----------

  /** Тихий помощник для фокуса и аналитики: свои встречи, блоки и рабочие часы недели. */
  weekData(tenantId: string, user: Viewer, from: number, to: number) {
    return this.weekInput(tenantId, user, from, to);
  }

  prefsRow(tenantId: string, userId: string): Promise<PrefsRow | null> {
    return this.repo.prefs(tenantId, userId);
  }

  busySpans(p: Person): BusySpan[] { return p.busy; }
}
