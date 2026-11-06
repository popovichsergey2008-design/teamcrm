import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { AppException } from '../../common/http/app-exception';
import { CalendarService } from '../calendar/calendar.service';
import { buildIcs, icsUid } from '../calendar/ics';
import { bookingSlots, BookingRules, defaultWeekly, slotAllowed, Weekly } from '../calendar/booking-slots';
import { zonedParts } from '../calendar/find-time';
import { GuestLinksService } from '../media/guest-links.service';
import { BookingRepository, BookingRow, BookingTypePublicRow, BookingTypeRow, RulesRow } from './booking.repository';

/** Готовые виды встреч (#4787, п. 7) — заводятся при первом открытии «Поделиться временем». */
const DEFAULT_TYPES = [
  { title: 'Знакомство', durationMin: 15, questions: [] as { text: string; required?: boolean }[] },
  { title: 'Обсуждение проекта', durationMin: 30, questions: [{ text: 'Что вы хотите обсудить?', required: false }] },
  { title: 'Демонстрация', durationMin: 45, questions: [] },
  { title: 'Рабочая встреча', durationMin: 60, questions: [] },
];

export interface TypeInput {
  /** #4787, п. 16 */
  mode?: 'personal' | 'round_robin' | 'collective' | 'group'; memberIds?: string[]; rrRule?: 'nearest' | 'even'; seats?: number | null;
  title: string; description?: string | null; durationMin: number; weekly?: Weekly | null;
  locationKind?: 'call' | 'place' | 'phone'; location?: string | null;
  bufferBefore?: number; bufferAfter?: number; questions?: { text: string; required?: boolean }[]; reminders?: number[];
}
export interface RulesInput {
  weekly: Weekly; blockedDates?: string[]; vacations?: { from: string; to: string }[];
  maxPerDay?: number | null; minNoticeMin?: number; horizonDays?: number; timezone?: string | null;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Запись по ссылке (#4787, п. 6–9): гость выбирает время на странице без аккаунта,
 * у организатора появляется обычная встреча с созвоном, гость получает подтверждение,
 * а в нём — «Перенести» и «Отменить» без переписки.
 */
@Injectable()
export class BookingService {
  private readonly log = new Logger('Booking');
  constructor(
    private readonly repo: BookingRepository,
    private readonly calendar: CalendarService,
    private readonly guests: GuestLinksService,
  ) {}

  private base() { return (process.env.APP_BASE_URL || 'https://app.qevo.one').replace(/\/+$/, ''); }
  bookUrl(slug: string) { return `${this.base()}/book/${slug}`; }
  manageUrl(token: string) { return `${this.base()}/book/manage/${token}`; }

  // ── виды встреч (п. 7) ──

  private typeView(t: BookingTypeRow) {
    return {
      id: String(t.id), slug: t.slug, url: this.bookUrl(t.slug), title: t.title, description: t.description,
      durationMin: t.duration_min, weekly: t.weekly, locationKind: t.location_kind, location: t.location,
      bufferBefore: t.buffer_before, bufferAfter: t.buffer_after, questions: t.questions ?? [], reminders: t.reminders ?? [],
      mode: t.mode ?? 'personal', memberIds: (t.member_ids ?? []).map(String), rrRule: t.rr_rule ?? 'nearest', seats: t.seats ?? null,
    };
  }

  private cleanType(t: TypeInput) {
    const title = String(t.title ?? '').trim().slice(0, 160);
    if (!title) throw AppException.validation('Назовите вид встречи');
    const durationMin = Math.round(Number(t.durationMin));
    if (!(durationMin >= 5 && durationMin <= 480)) throw AppException.validation('Продолжительность — от 5 минут до 8 часов');
    const weekly = t.weekly ? this.cleanWeekly(t.weekly, true) : null;
    const locationKind = t.locationKind === 'place' || t.locationKind === 'phone' ? t.locationKind : 'call';
    const clampBuf = (n: unknown) => Math.max(0, Math.min(240, Math.round(Number(n) || 0)));
    const questions = (t.questions ?? []).map((q) => ({ text: String(q.text ?? '').trim().slice(0, 300), required: !!q.required })).filter((q) => q.text).slice(0, 10);
    const reminders = [...new Set((t.reminders ?? [15]).map((n) => Math.round(Number(n))).filter((n) => n >= 0 && n <= 20160))].slice(0, 6);
    const mode = (['round_robin', 'collective', 'group'] as const).find((m) => m === t.mode) ?? 'personal';
    const memberIds = [...new Set((t.memberIds ?? []).map(String))].slice(0, 20);
    if ((mode === 'round_robin' || mode === 'collective') && !memberIds.length) throw AppException.validation('Выберите сотрудников команды');
    const seats = mode === 'group' ? Math.max(2, Math.min(500, Math.round(Number(t.seats) || 10))) : null;
    return {
      title, description: t.description?.trim().slice(0, 1000) || null, durationMin, weekly, locationKind,
      location: t.location?.trim().slice(0, 255) || null, bufferBefore: clampBuf(t.bufferBefore), bufferAfter: clampBuf(t.bufferAfter),
      questions, reminders, mode, memberIds: mode === 'round_robin' || mode === 'collective' ? memberIds : [], rrRule: t.rrRule === 'even' ? 'even' : 'nearest', seats,
    };
  }

  private cleanWeekly(w: Weekly, allowEmpty = false): Weekly {
    const out: Weekly = {};
    for (const [day, list] of Object.entries(w ?? {})) {
      if (!/^[0-6]$/.test(day) || !Array.isArray(list)) continue;
      const ok = list.filter((x) => Array.isArray(x) && HHMM.test(x[0]) && HHMM.test(x[1]) && x[0] < x[1]).slice(0, 6) as [string, string][];
      if (ok.length) out[day] = ok.sort((a, b) => a[0].localeCompare(b[0]));
    }
    if (!allowEmpty && !Object.keys(out).length) throw AppException.validation('Укажите хотя бы один день и часы для встреч');
    return out;
  }

  async types(tenantId: string, userId: string) {
    if (!(await this.repo.hasAnyType(tenantId, userId))) {
      for (const [i, d] of DEFAULT_TYPES.entries()) {
        await this.repo.createType(tenantId, userId, this.newSlug(), {
          title: d.title, description: null, durationMin: d.durationMin, weekly: null, locationKind: 'call', location: null,
          bufferBefore: 0, bufferAfter: 0, questions: d.questions, reminders: [15], position: i,
        });
      }
    }
    return (await this.repo.types(tenantId, userId)).map((t) => this.typeView(t));
  }

  private newSlug() { return randomBytes(9).toString('base64url'); }

  /** Состав команды — только сотрудники этой же компании. */
  private async checkTeam(tenantId: string, ids: string[]) {
    if (!ids.length) return;
    const ok = await this.repo.teamMembers(tenantId, ids);
    if (ok.length !== new Set(ids).size) throw AppException.validation('В команде могут быть только сотрудники компании');
  }

  async createType(tenantId: string, userId: string, t: TypeInput) {
    const c = this.cleanType(t);
    await this.checkTeam(tenantId, c.memberIds);
    const n = (await this.repo.types(tenantId, userId)).length;
    if (n >= 30) throw AppException.validation('Не больше 30 видов встреч');
    const row = await this.repo.createType(tenantId, userId, this.newSlug(), { ...c, position: n });
    return this.typeView(row!);
  }

  async updateType(tenantId: string, userId: string, id: string, t: TypeInput) {
    const c = this.cleanType(t);
    await this.checkTeam(tenantId, c.memberIds);
    const row = await this.repo.updateType(tenantId, userId, id, c);
    if (!row) throw AppException.notFound('Вид встречи не найден');
    return this.typeView(row);
  }

  async removeType(tenantId: string, userId: string, id: string) {
    await this.repo.deactivateType(tenantId, userId, id);
    return { ok: true };
  }

  // ── правила доступности (п. 8) ──

  private async rulesOf(tenantId: string, userId: string): Promise<{ rules: BookingRules; timeZone: string; saved: boolean }> {
    const [row, me] = await Promise.all([this.repo.rules(tenantId, userId), this.repo.userTz(tenantId, userId)]);
    if (row) return { rules: this.rulesFromRow(row), timeZone: row.timezone || me?.tz || 'Europe/Moscow', saved: true };
    const work = await this.calendar.work(tenantId);
    return {
      rules: {
        weekly: defaultWeekly(work.workStart, work.workEnd, work.weekendDays), blockedDates: work.holidays ?? [],
        vacations: [], maxPerDay: null, minNoticeMin: 180, horizonDays: 14,
      },
      timeZone: me?.tz || 'Europe/Moscow', saved: false,
    };
  }

  private rulesFromRow(r: RulesRow): BookingRules {
    return {
      weekly: r.weekly ?? {},
      blockedDates: (r.blocked_dates ?? []).map((d) => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10))),
      vacations: r.vacations ?? [], maxPerDay: r.max_per_day, minNoticeMin: r.min_notice_min, horizonDays: r.horizon_days,
    };
  }

  async rules(tenantId: string, userId: string) {
    const r = await this.rulesOf(tenantId, userId);
    return { ...r.rules, timezone: r.timeZone, saved: r.saved };
  }

  async saveRules(tenantId: string, userId: string, r: RulesInput) {
    const weekly = this.cleanWeekly(r.weekly);
    const blockedDates = [...new Set((r.blockedDates ?? []).filter((d) => DATE.test(d)))].slice(0, 366);
    const vacations = (r.vacations ?? []).filter((v) => DATE.test(v.from) && DATE.test(v.to) && v.from <= v.to).slice(0, 50);
    const maxPerDay = r.maxPerDay == null || Number(r.maxPerDay) <= 0 ? null : Math.min(50, Math.round(Number(r.maxPerDay)));
    const minNoticeMin = Math.max(0, Math.min(20160, Math.round(Number(r.minNoticeMin ?? 180))));
    const horizonDays = Math.max(1, Math.min(365, Math.round(Number(r.horizonDays ?? 14))));
    let timezone: string | null = r.timezone?.trim() || null;
    if (timezone) { try { new Intl.DateTimeFormat('ru-RU', { timeZone: timezone }); } catch { timezone = null; } }
    await this.repo.saveRules(tenantId, userId, { weekly, blockedDates, vacations, maxPerDay, minNoticeMin, horizonDays, timezone });
    return this.rules(tenantId, userId);
  }

  async upcoming(tenantId: string, userId: string) {
    return (await this.repo.upcoming(tenantId, userId)).map((b) => ({
      id: String(b.id), typeTitle: b.type_title, guestName: b.guest_name, guestEmail: b.guest_email,
      startsAt: b.starts_at.toISOString(), endsAt: b.ends_at.toISOString(), eventId: b.event_id ? String(b.event_id) : null,
    }));
  }

  // ── расчёт слотов ──

  /** Кто ведёт встречи вида: сам человек, команда по очереди, все сразу (п. 16). */
  private hosts(t: BookingTypeRow): string[] {
    const members = (t.member_ids ?? []).map(String);
    if (t.mode === 'round_robin') return members.length ? members : [String(t.user_id)];
    if (t.mode === 'collective') return [...new Set([String(t.user_id), ...members])];
    return [String(t.user_id)];
  }

  private async slotsInput(t: BookingTypeRow, exceptBookingId: string | null, hostId: string = String(t.user_id)) {
    const { rules, timeZone } = await this.rulesOf(String(t.tenant_id), hostId);
    const now = Date.now();
    const to = new Date(now + (rules.horizonDays + 2) * 86_400_000).toISOString();
    const busyRows = await this.repo.busy(String(t.tenant_id), hostId, new Date(now - 86_400_000).toISOString(), to, exceptBookingId);
    return { rules, timeZone, busyRows, now };
  }

  private input(t: BookingTypeRow, rules: BookingRules, timeZone: string, busyRows: { starts_at: Date; ends_at: Date; kind?: string }[], now: number) {
    const meetingsPerDay: Record<string, number> = {};
    for (const b of busyRows) {
      if (b.kind === 'block' || b.kind === 'external') continue;
      const d = zonedParts(b.starts_at.getTime(), timeZone).date;
      meetingsPerDay[d] = (meetingsPerDay[d] ?? 0) + 1;
    }
    return {
      now, rules, timeZone, meetingsPerDay,
      type: { durationMin: t.duration_min, weekly: t.weekly, bufferBefore: t.buffer_before, bufferAfter: t.buffer_after },
      busy: busyRows.map((b) => ({ start: b.starts_at.getTime(), end: b.ends_at.getTime() })),
    };
  }

  /** Свободные слоты одного ведущего — моментами (мс). */
  private async hostSlots(t: BookingTypeRow, hostId: string, exceptBookingId: string | null) {
    const { rules, timeZone, busyRows, now } = await this.slotsInput(t, exceptBookingId, hostId);
    return { slots: new Set(bookingSlots(this.input(t, rules, timeZone, busyRows, now)).flatMap((d) => d.slots)), timeZone, rules, now };
  }

  private group(slots: Iterable<string>, timeZone: string) {
    const by = new Map<string, string[]>();
    for (const s of [...slots].sort()) {
      const d = zonedParts(Date.parse(s), timeZone).date;
      (by.get(d) ?? by.set(d, []).get(d)!).push(s);
    }
    return [...by.entries()].map(([date, slots]) => ({ date, slots }));
  }

  /**
   * Дни и время для гостя (п. 6, 16): к себе — свои правила; к команде — объединение
   * свободного времени сотрудников; ко всем сразу — только общее; группа — ещё и уже
   * назначенные потоки, где остались места.
   */
  private async daysFor(t: BookingTypeRow, exceptBookingId: string | null = null) {
    const hosts = this.hosts(t);
    const per = await Promise.all(hosts.map((h) => this.hostSlots(t, h, exceptBookingId)));
    const tz = per[0].timeZone;
    let slots: Set<string>;
    if (t.mode === 'round_robin') slots = new Set(per.flatMap((p) => [...p.slots]));
    else if (t.mode === 'collective') slots = new Set([...per[0].slots].filter((s) => per.every((p) => p.slots.has(s))));
    else slots = per[0].slots;
    if (t.mode === 'group') {
      const earliest = per[0].now + per[0].rules.minNoticeMin * 60_000;
      for (const g of await this.repo.groupSessions(String(t.id), exceptBookingId)) {
        if (g.starts_at.getTime() >= earliest && g.taken < (t.seats ?? 10)) slots.add(g.starts_at.toISOString());
      }
    }
    return this.group(slots, tz);
  }

  private publicType(t: BookingTypePublicRow) {
    return {
      organizer: { name: t.owner_name, avatarUrl: t.owner_avatar ? `/api/book/${t.slug}/avatar` : null, company: t.tenant_name },
      type: {
        slug: t.slug, title: t.title, description: t.description, durationMin: t.duration_min,
        locationKind: t.location_kind, location: t.location_kind === 'call' ? null : t.location, questions: t.questions ?? [],
      },
      organizerTimeZone: t.owner_tz || 'Europe/Moscow',
    };
  }

  // ── публичная страница (п. 6) ──

  async page(slug: string) {
    const t = await this.repo.typeBySlug(slug);
    if (!t) throw AppException.notFound('Ссылка записи не найдена или выключена');
    return { ...this.publicType(t), days: await this.daysFor(t) };
  }

  async avatar(slug: string) {
    const t = await this.repo.typeBySlug(slug);
    if (!t?.owner_avatar) throw AppException.notFound('Нет фото');
    return { tenantId: String(t.tenant_id), fileId: String(t.owner_avatar) };
  }

  async book(slug: string, dto: { startsAt: string; name: string; email: string; timeZone?: string; answers?: string[] }) {
    const t = await this.repo.typeBySlug(slug);
    if (!t) throw AppException.notFound('Ссылка записи не найдена или выключена');
    const name = String(dto.name ?? '').trim().slice(0, 120);
    const email = String(dto.email ?? '').trim().toLowerCase();
    if (!name) throw AppException.validation('Укажите имя');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) throw AppException.validation('Проверьте адрес почты');
    const start = Date.parse(dto.startsAt);
    if (Number.isNaN(start)) throw AppException.validation('Выберите время');
    const questions = t.questions ?? [];
    const answers = questions.map((q, i) => ({ q: q.text, a: String(dto.answers?.[i] ?? '').trim().slice(0, 2000) }));
    if (questions.some((q, i) => q.required && !answers[i].a)) throw AppException.validation('Ответьте на обязательный вопрос');
    const token = randomBytes(24).toString('base64url');
    const placed = await this.place(t, start, { guestName: name, guestEmail: email, guestTz: this.cleanTz(dto.timeZone), answers, manageHash: sha(token) }, null);
    const row = placed.row;
    await this.mailGuest('confirm', t, row, token, placed.callUrl);
    await this.mailOrganizer('new', t, row);
    return {
      ...this.publicType(t),
      booking: { startsAt: row.starts_at.toISOString(), endsAt: row.ends_at.toISOString(), name, email, callUrl: placed.callUrl, manageUrl: this.manageUrl(token) },
    };
  }

  /**
   * Занять время по правилам вида (п. 6, 16) и завести встречу.
   * Групповая: к уже назначенному потоку, пока есть места, иначе — новый поток.
   * К команде: ведущий — ближайший доступный или тот, у кого меньше записей.
   * Ко всем сразу: время должно быть свободно у каждого, встреча — общая.
   */
  private async place(t: BookingTypePublicRow, start: number, guest: { guestName: string; guestEmail: string; guestTz: string | null; answers: unknown; manageHash: string }, exceptBookingId: string | null) {
    const tenantId = String(t.tenant_id);
    const end = start + t.duration_min * 60_000;
    const startsAt = new Date(start).toISOString();
    const endsAt = new Date(end).toISOString();
    const fresh = async () => this.daysFor(t, exceptBookingId);
    const taken = async () => AppException.conflict('Это время только что заняли — выберите другое', { days: await fresh() });

    if (t.mode === 'group') {
      const session = (await this.repo.groupSessions(String(t.id), exceptBookingId)).find((g) => g.starts_at.getTime() === start);
      if (session?.event_id) {
        // в существующий поток — только пока есть места; места считаем под замком
        const row = await this.repo.reserveFor(tenantId, [String(t.user_id)], () => true, { typeId: String(t.id), hostId: String(t.user_id), ...guest, startsAt, endsAt, isGroup: true, eventId: session.event_id, exceptBookingId });
        if (!row || (await this.repo.groupSessions(String(t.id))).find((g) => g.starts_at.getTime() === start)!.taken > (t.seats ?? 10)) {
          if (row) await this.repo.cancel(String(row.id));
          throw AppException.conflict('Места на это время закончились — выберите другое', { days: await fresh() });
        }
        const callUrl = await this.inviteToEvent(t, String(t.user_id), session.event_id, guest.guestEmail, guest.guestName);
        return { row, callUrl, hostId: String(t.user_id) };
      }
    }

    // кто ведёт: по правилу команды — среди тех, кто свободен в это время
    const hosts = this.hosts(t);
    const free: string[] = [];
    for (const h of hosts) if ((await this.hostSlots(t, h, exceptBookingId)).slots.has(startsAt)) free.push(h);
    let hostId = String(t.user_id);
    if (t.mode === 'round_robin') {
      if (!free.length) throw await taken();
      hostId = free[0];
      if (t.rr_rule === 'even') {
        const counts = await Promise.all(free.map(async (h) => ({ h, n: await this.repo.recentCount(String(t.id), h) })));
        hostId = counts.sort((a, b) => a.n - b.n)[0].h;
      }
    } else if (t.mode === 'collective') {
      if (free.length !== hosts.length) throw await taken();
    } else if (!free.length) throw await taken();
    const lockIds = t.mode === 'collective' ? hosts : [hostId];
    const ruled = await Promise.all(lockIds.map(async (h) => ({ h, ...(await this.slotsInput(t, exceptBookingId, h)) })));
    const row = await this.repo.reserveFor(tenantId, lockIds,
      (busy) => ruled.every((r) => slotAllowed(this.input(t, r.rules, r.timeZone, busy[r.h] ?? [], r.now), start)),
      { typeId: String(t.id), hostId, ...guest, startsAt, endsAt, isGroup: t.mode === 'group', exceptBookingId });
    if (!row) throw await taken();

    try {
      const others = t.mode === 'collective' ? hosts.filter((h) => h !== hostId) : [];
      const ev = await this.calendar.create(tenantId, { userId: hostId, role: 'member' }, {
        title: (t.mode === 'group' ? t.title : `${t.title}: ${guest.guestName}`).slice(0, 255),
        description: this.description(guest.guestEmail, guest.answers as { q: string; a: string }[]),
        location: t.location_kind === 'call' ? undefined : (t.location ?? undefined),
        startsAt, endsAt, scope: 'personal', participantIds: others, isCall: t.location_kind === 'call', reminders: t.reminders ?? [15],
      } as Parameters<CalendarService['create']>[2]);
      await this.repo.setEvent(String(row.id), String(ev.id));
      row.event_id = String(ev.id);
      const callUrl = await this.inviteToEvent(t, hostId, String(ev.id), guest.guestEmail, guest.guestName);
      return { row, callUrl, hostId };
    } catch (e) {
      await this.repo.cancel(String(row.id));
      this.log.warn(`запись ${row.id}: встреча не создана — ${(e as Error).message}`);
      throw AppException.conflict('Не удалось записать на это время — выберите другое', { days: await fresh() });
    }
  }

  private async inviteToEvent(t: BookingTypeRow, hostId: string, eventId: string, email: string, name: string) {
    if (t.location_kind !== 'call') return null;
    const inv = await this.guests.inviteGuest({ userId: hostId, tenantId: String(t.tenant_id) }, eventId, email, name, { silent: true });
    return inv.url;
  }

  /** Убрать гостя со встречи: свою — целиком, общую групповую — только его место. */
  private async leaveEvent(t: BookingTypeRow, b: BookingRow) {
    if (!b.event_id) return;
    const host = { userId: String(b.user_id), role: 'member' };
    if (b.is_group && (await this.repo.confirmedOnEvent(String(b.event_id))) > 0) {
      const invites = await this.guests.listInvites({ userId: host.userId, tenantId: String(t.tenant_id) }, String(b.event_id)).catch(() => []);
      const mine = (invites as { id: string; email?: string | null }[]).find((i) => (i.email ?? '').toLowerCase() === b.guest_email.toLowerCase());
      if (mine) await this.guests.revokeInvite({ userId: host.userId, tenantId: String(t.tenant_id) }, String(b.event_id), mine.id).catch(() => undefined);
      return;
    }
    await this.calendar.remove(String(t.tenant_id), host, String(b.event_id)).catch((e) => {
      this.log.warn(`запись ${b.id}: встреча ${b.event_id} — ${(e as Error).message}`);
    });
  }

  private cleanTz(tz?: string | null): string | null {
    const v = String(tz ?? '').trim().slice(0, 64);
    if (!v) return null;
    try { new Intl.DateTimeFormat('ru-RU', { timeZone: v }); return v; } catch { return null; }
  }

  private description(email: string, answers: { q: string; a: string }[]) {
    return [`Запись по ссылке. Гость: ${email}`, ...answers.filter((x) => x.a).map((x) => `${x.q}\n${x.a}`)].join('\n\n').slice(0, 4000);
  }

  private when(startsAt: Date, endsAt: Date, tz: string) {
    const s = startsAt.toLocaleString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: tz });
    const e = endsAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: tz });
    let zone = '';
    try { zone = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(startsAt).find((x) => x.type === 'timeZoneName')?.value ?? ''; } catch { /* без подписи */ }
    return `${s}–${e}${zone ? ` (${zone})` : ''}`;
  }

  /** Подтверждение гостю (п. 6, 9, 20): время в ЕГО поясе, ссылка на созвон, перенос и отмена. */
  private async mailGuest(kind: 'confirm', t: BookingTypePublicRow, b: BookingRow, token: string, callUrl: string | null, dedupSuffix = '') {
    const tz = b.guest_tz || t.owner_tz || 'Europe/Moscow';
    const manage = this.manageUrl(token);
    const lines = [
      `Здравствуйте, ${b.guest_name}!`, '',
      `Вы записаны на встречу «${t.title}». Организатор: ${t.owner_name}.`,
      `Когда: ${this.when(b.starts_at, b.ends_at, tz)}`,
      t.location_kind === 'call'
        ? (callUrl ? `Ссылка на созвон: ${callUrl}\nНичего устанавливать не нужно — встреча работает в браузере.` : '')
        : t.location ? `Где: ${t.location}` : '',
      '',
      `Перенести встречу: ${manage}?do=reschedule`,
      `Отменить встречу: ${manage}?do=cancel`,
      '',
      'К письму приложен файл встречи — им можно добавить её в свой календарь.',
      '', `Хотите так же принимать записи? Создайте свою страницу записи в QEVO: ${this.base()}/`,
    ];
    const ics = buildIcs({
      uid: icsUid(String(t.tenant_id), `b${b.id}`), title: `${t.title} — ${t.owner_name}`, description: callUrl ? `Созвон: ${callUrl}` : null,
      location: t.location_kind === 'call' ? callUrl : t.location, startsAt: b.starts_at, endsAt: b.ends_at, allDay: false,
      organizer: { name: t.owner_name, email: null }, attendees: [{ name: b.guest_name, email: b.guest_email }],
      method: 'REQUEST', sequence: 0, url: callUrl,
    } as Parameters<typeof buildIcs>[0]);
    await this.repo.mail(String(t.tenant_id), b.guest_email, `Встреча подтверждена: ${t.title}`, lines.filter((x, i, a) => x || a[i - 1]).join('\n'),
      `booking.${kind}`, `booking.${kind}:${b.id}${dedupSuffix}`, [{ name: 'meeting.ics', content: Buffer.from(ics, 'utf8').toString('base64') }]);
  }

  /** Организатору — что произошло с его записью: новая, перенесена, отменена. */
  private async mailOrganizer(kind: 'new' | 'moved' | 'cancelled', t: BookingTypePublicRow, b: BookingRow) {
    const me = await this.repo.userTz(String(t.tenant_id), String(b.user_id ?? t.user_id));
    if (!me?.email) return;
    const tz = me.tz || 'Europe/Moscow';
    const head = kind === 'new' ? 'Новая запись по ссылке' : kind === 'moved' ? 'Гость перенёс встречу' : 'Гость отменил встречу';
    const text = [
      `${head}: «${t.title}».`, '',
      `Гость: ${b.guest_name} <${b.guest_email}>`,
      `Когда: ${this.when(b.starts_at, b.ends_at, tz)}`,
      ...(b.answers ?? []).filter((x) => x.a).map((x) => `${x.q}: ${x.a}`),
      '', kind === 'cancelled' ? 'Встреча убрана из вашего календаря.' : `Встреча — в вашем календаре: ${this.base()}/calendar`,
    ].join('\n');
    await this.repo.mail(String(t.tenant_id), me.email, `${head}: ${b.guest_name}`, text, `booking.organizer-${kind}`, `booking.org.${kind}:${b.id}:${b.starts_at.getTime()}`);
  }

  // ── перенос и отмена гостем (п. 9) ──

  private async byToken(token: string) {
    const b = await this.repo.byManageHash(sha(String(token ?? '')));
    if (!b) throw AppException.notFound('Запись не найдена');
    const t = await this.repo.typeOf(String(b.type_id));
    if (!t) throw AppException.notFound('Запись не найдена');
    return { b, t };
  }

  async manage(token: string) {
    const { b, t } = await this.byToken(token);
    return {
      ...this.publicType(t),
      booking: {
        status: b.status, startsAt: b.starts_at.toISOString(), endsAt: b.ends_at.toISOString(), name: b.guest_name, email: b.guest_email,
        past: b.ends_at.getTime() < Date.now(),
      },
      days: b.status === 'confirmed' && b.starts_at.getTime() > Date.now() ? await this.daysFor(t, String(b.id)) : [],
    };
  }

  async reschedule(token: string, startsAtRaw: string) {
    const { b, t } = await this.byToken(token);
    if (b.status !== 'confirmed') throw AppException.conflict('Встреча уже отменена');
    if (b.starts_at.getTime() <= Date.now()) throw AppException.conflict('Встреча уже началась — перенести её нельзя');
    const start = Date.parse(startsAtRaw);
    if (Number.isNaN(start)) throw AppException.validation('Выберите время');
    const end = start + t.duration_min * 60_000;
    const days = await this.daysFor(t, String(b.id));
    if (!days.some((d) => d.slots.includes(new Date(start).toISOString()))) {
      throw AppException.conflict('Это время только что заняли — выберите другое', { days });
    }
    if (t.mode === 'personal' || t.mode === 'collective') {
      // та же встреча, новое время: письмо гостю о переносе, напоминания и ссылка — следом
      const ok = await this.repo.move(String(t.tenant_id), String(b.user_id), String(b.id), () => true, new Date(start).toISOString(), new Date(end).toISOString());
      if (!ok) throw AppException.conflict('Это время только что заняли — выберите другое', { days });
      if (b.event_id) {
        await this.calendar.update(String(t.tenant_id), { userId: String(b.user_id), role: 'member' }, String(b.event_id),
          { startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() } as Parameters<CalendarService['update']>[3]);
      }
    } else {
      // к команде — ведущий мог смениться; группа — другой поток: место переезжает, а не копируется
      await this.repo.cancel(String(b.id));
      try {
        const placed = await this.place(t, start, {
          guestName: b.guest_name, guestEmail: b.guest_email, guestTz: b.guest_tz, answers: b.answers, manageHash: sha(`${token}~move~${Date.now()}`),
        }, String(b.id));
        await this.leaveEvent(t, b);
        // запись остаётся той же (ссылка «перенести/отменить» не меняется): переносим на неё новое место
        await this.repo.swapIn(String(b.id), String(placed.row.id), placed.hostId, new Date(start).toISOString(), new Date(end).toISOString(), placed.row.event_id ? String(placed.row.event_id) : null);
        // новая встреча — новая ссылка на созвон: гостю подтверждение с ней и с прежними «перенести/отменить»
        await this.mailGuest('confirm', t, { ...b, user_id: placed.hostId, starts_at: new Date(start), ends_at: new Date(end) }, token, placed.callUrl, `:${start}`);
      } catch (e) {
        await this.repo.restore(String(b.id));
        throw e;
      }
    }
    const moved = { ...b, starts_at: new Date(start), ends_at: new Date(end) };
    await this.mailOrganizer('moved', t, moved);
    return this.manage(token);
  }

  async cancel(token: string) {
    const { b, t } = await this.byToken(token);
    if (b.status === 'cancelled') return this.manage(token);
    if (b.ends_at.getTime() <= Date.now()) throw AppException.conflict('Встреча уже прошла');
    await this.repo.cancel(String(b.id));
    // своя встреча уходит из календаря — с ней письмо гостю и все напоминания; общая групповая — только его место
    await this.leaveEvent(t, b);
    await this.mailOrganizer('cancelled', t, b);
    return this.manage(token);
  }

}
