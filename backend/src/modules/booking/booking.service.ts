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
    return {
      title, description: t.description?.trim().slice(0, 1000) || null, durationMin, weekly, locationKind,
      location: t.location?.trim().slice(0, 255) || null, bufferBefore: clampBuf(t.bufferBefore), bufferAfter: clampBuf(t.bufferAfter),
      questions, reminders,
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

  async createType(tenantId: string, userId: string, t: TypeInput) {
    const c = this.cleanType(t);
    const n = (await this.repo.types(tenantId, userId)).length;
    if (n >= 30) throw AppException.validation('Не больше 30 видов встреч');
    const row = await this.repo.createType(tenantId, userId, this.newSlug(), { ...c, position: n });
    return this.typeView(row!);
  }

  async updateType(tenantId: string, userId: string, id: string, t: TypeInput) {
    const row = await this.repo.updateType(tenantId, userId, id, this.cleanType(t));
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

  private async slotsInput(t: BookingTypeRow, exceptBookingId: string | null) {
    const { rules, timeZone } = await this.rulesOf(String(t.tenant_id), String(t.user_id));
    const now = Date.now();
    const to = new Date(now + (rules.horizonDays + 2) * 86_400_000).toISOString();
    const busyRows = await this.repo.busy(String(t.tenant_id), String(t.user_id), new Date(now - 86_400_000).toISOString(), to, exceptBookingId);
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

  private async daysFor(t: BookingTypeRow, exceptBookingId: string | null = null) {
    const { rules, timeZone, busyRows, now } = await this.slotsInput(t, exceptBookingId);
    return bookingSlots(this.input(t, rules, timeZone, busyRows, now));
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
    const guestTz = this.cleanTz(dto.timeZone);

    const { rules, timeZone, now } = await this.slotsInput(t, null);
    const end = start + t.duration_min * 60_000;
    const token = randomBytes(24).toString('base64url');
    const row = await this.repo.reserve(String(t.tenant_id), String(t.user_id),
      (busy) => slotAllowed(this.input(t, rules, timeZone, busy.map((b) => ({ ...b, kind: (b as { kind?: string }).kind })), now), start),
      { typeId: String(t.id), guestName: name, guestEmail: email, guestTz, answers, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), manageHash: sha(token) });
    if (!row) {
      // занято, пока гость выбирал: подтверждение получает только один, второму — другие варианты
      throw AppException.conflict('Это время только что заняли — выберите другое', { days: await this.daysFor(t) });
    }

    let callUrl: string | null = null;
    try {
      const ev = await this.calendar.create(String(t.tenant_id), { userId: String(t.user_id), role: 'member' }, {
        title: `${t.title}: ${name}`.slice(0, 255),
        description: this.description(email, answers),
        location: t.location_kind === 'call' ? undefined : (t.location ?? undefined),
        startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(),
        scope: 'personal', participantIds: [], isCall: t.location_kind === 'call', reminders: t.reminders ?? [15],
      } as Parameters<CalendarService['create']>[2]);
      await this.repo.setEvent(String(row.id), String(ev.id));
      if (t.location_kind === 'call') {
        const inv = await this.guests.inviteGuest({ userId: String(t.user_id), tenantId: String(t.tenant_id) }, String(ev.id), email, name, { silent: true });
        callUrl = inv.url;
      }
    } catch (e) {
      await this.repo.cancel(String(row.id));
      this.log.warn(`запись ${row.id}: встреча не создана — ${(e as Error).message}`);
      throw AppException.conflict('Не удалось записать на это время — выберите другое', { days: await this.daysFor(t) });
    }

    await this.mailGuest('confirm', t, row, token, callUrl);
    await this.mailOrganizer('new', t, row);
    return {
      ...this.publicType(t),
      booking: { startsAt: row.starts_at.toISOString(), endsAt: row.ends_at.toISOString(), name, email, callUrl, manageUrl: this.manageUrl(token) },
    };
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
  private async mailGuest(kind: 'confirm', t: BookingTypePublicRow, b: BookingRow, token: string, callUrl: string | null) {
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
      `booking.${kind}`, `booking.${kind}:${b.id}`, [{ name: 'meeting.ics', content: Buffer.from(ics, 'utf8').toString('base64') }]);
  }

  /** Организатору — что произошло с его записью: новая, перенесена, отменена. */
  private async mailOrganizer(kind: 'new' | 'moved' | 'cancelled', t: BookingTypePublicRow, b: BookingRow) {
    const me = await this.repo.userTz(String(t.tenant_id), String(t.user_id));
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
    const { rules, timeZone, now } = await this.slotsInput(t, String(b.id));
    const ok = await this.repo.move(String(t.tenant_id), String(t.user_id), String(b.id),
      (busy) => slotAllowed(this.input(t, rules, timeZone, busy, now), start), new Date(start).toISOString(), new Date(end).toISOString());
    if (!ok) throw AppException.conflict('Это время только что заняли — выберите другое', { days: await this.daysFor(t, String(b.id)) });
    // та же встреча, новое время: письмо гостю о переносе, напоминания и ссылка — следом (без второй встречи)
    if (b.event_id) {
      await this.calendar.update(String(t.tenant_id), { userId: String(t.user_id), role: 'member' }, String(b.event_id),
        { startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() } as Parameters<CalendarService['update']>[3]);
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
    // встреча уходит из календаря — с ней письмо гостю об отмене и все напоминания
    if (b.event_id) {
      await this.calendar.remove(String(t.tenant_id), { userId: String(t.user_id), role: 'member' }, String(b.event_id)).catch((e) => {
        this.log.warn(`отмена записи ${b.id}: встреча ${b.event_id} — ${(e as Error).message}`);
      });
    }
    await this.mailOrganizer('cancelled', t, b);
    return this.manage(token);
  }
}
