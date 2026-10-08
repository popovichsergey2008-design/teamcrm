import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { AppException } from '../../common/http/app-exception';
import { RealtimeService } from '../realtime/realtime.service';
import { PushService } from '../notifications/push.service';
import { TelegramMirror } from '../notifications/telegram-mirror.service';
import { GuestLinkRow, GuestLinksRepository, HostCallRow } from './guest-links.repository';
import { CalendarMailService } from '../calendar/calendar-mail.service';
import { IntegrationCryptoService } from '../integrations/crypto.service';
import { MediaService } from './media.service';

/** Токен гостя живёт заметно меньше ссылки: ссылку присылают заранее, входят один раз. */
const GUEST_TOKEN_TTL_SEC = 4 * 60 * 60;
const DEFAULT_TTL_HOURS = 24;
const MAX_TTL_HOURS = 30 * 24;

/**
 * Процесс «ссылку отправили заранее» (задача заказчика: «встреча завтра в 9»).
 *
 * Комната поднимается сама, когда в неё кто-то входит, — но впустить гостя может
 * только сотрудник, а стук слышат лишь те, кто уже внутри. Поэтому у ссылки есть
 * время встречи, и вокруг него три правила:
 * - гость до начала видит время и отсчёт; постучаться можно за OPEN_BEFORE_MIN до начала;
 * - автору ссылки (и сотрудникам события) за REMIND_BEFORE_MIN приходит напоминание
 *   открыть комнату — всплывашкой с кнопкой «Войти», push и в Telegram;
 * - гость постучал, а в комнате никого — их зовут сразу, а не «когда-нибудь заглянут».
 */
export const OPEN_BEFORE_MIN = 15;
export const REMIND_BEFORE_MIN = 10;
/** Ссылка живёт не меньше этого после начала: встреча может затянуться, гость — опоздать. */
const STAY_AFTER_START_H = 4;
/** Гость переподключается и стучит снова: хозяина зовём не чаще раза в это время. */
const HOST_CALL_EVERY_MS = 2 * 60_000;

/** Что лежит в гостевом JWT. Намеренно НЕ совместимо с AccessTokenPayload. */
export interface GuestTokenPayload {
  kind: 'guest';
  gid: string;
  tenantId: string;
  roomId: string;
  name: string;
  /**
   * Разговор, ради которого выдана ссылка.
   *
   * По нему внешний участник читает и пишет — и ничего, кроме него: ссылку пересылают,
   * и открывать она должна ровно один чат, а не «переписку компании».
   */
  chatId?: string | null;
  /** Ссылка, по которой вошёл гость: по её времени встречи решаем, не рано ли стучаться. */
  linkId?: string;
}

export type LinkRefusal = 'unknown' | 'revoked' | 'expired' | 'used-up' | 'cancelled' | 'invite-revoked';

@Injectable()
export class GuestLinksService {
  private readonly log = new Logger('MeetGuest');

  constructor(
    private readonly repo: GuestLinksRepository,
    private readonly media: MediaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly realtime: RealtimeService,
    private readonly push: PushService,
    private readonly telegram: TelegramMirror,
    private readonly mail: CalendarMailService,
    private readonly crypto: IntegrationCryptoService,
  ) {}

  /** Комната → когда последний раз звали хозяина. */
  private readonly hostCalledAt = new Map<string, number>();

  private sha256(v: string) {
    return createHash('sha256').update(v).digest('hex');
  }

  /**
   * Создать ссылку. `roomId` передаётся, когда гостя зовут в ИДУЩИЙ созвон; без него
   * выделяется новая комната — «переговорная под ссылку», которая поднимется при
   * первом входе. Полный адрес возвращается один раз: в базе только хэш.
   */
  async create(
    tenantId: string, createdBy: string,
    input: {
      roomId?: string; projectId?: string | null; label?: string | null; ttlHours?: number;
      /** Разговор, ради которого ссылка выдана: по нему её потом и находят. */
      chatId?: string | null;
      /** Когда встреча (ISO). Без него ссылка открыта сразу, как и раньше. */
      startsAt?: string | null;
      /** Событие календаря: время и комната берутся из него. */
      eventId?: string | null;
    },
  ) {
    let roomId = input.roomId?.trim() || randomUUID();
    let startsAt: Date | null = null;
    let endsAt: Date | null = null;
    let label = input.label?.trim()?.slice(0, 120) || null;
    if (input.eventId) {
      /*
        Ссылка из события: комната — та же, что у кнопки «Войти в созвон» в событии.
        Иначе сотрудники пришли бы по календарю в одну комнату, а гость — в другую,
        и каждый ждал бы остальных.
      */
      const ev = await this.repo.eventOf(tenantId, String(input.eventId));
      if (!ev) throw AppException.notFound('Событие не найдено');
      roomId = ev.meet_room_id || await this.repo.setEventRoom(tenantId, String(ev.id), roomId);
      startsAt = new Date(ev.starts_at);
      endsAt = new Date(ev.ends_at);
      label = label ?? ev.title.slice(0, 120);
    } else if (input.startsAt) {
      startsAt = new Date(input.startsAt);
      if (Number.isNaN(startsAt.getTime())) throw AppException.validation('Не понял время встречи');
    }
    if (startsAt && startsAt.getTime() < Date.now() - 5 * 60_000) {
      throw AppException.validation('Время встречи уже прошло — укажите будущее или уберите время');
    }
    // чужую комнату в ссылку не заворачиваем: id угадать нельзя, но проверить дёшево
    if (input.roomId) {
      const room = this.media.getRoom(roomId);
      if (room && room.tenantId !== tenantId) throw AppException.notFound('Созвон не найден');
    }
    const hours = Math.min(Math.max(Number(input.ttlHours) || DEFAULT_TTL_HOURS, 1), MAX_TTL_HOURS);
    /*
      Срок у ссылки со временем встречи — не раньше конца встречи: «сутки» для встречи
      через неделю означали бы ссылку, умершую до начала.
    */
    let expiresAt = new Date(Date.now() + hours * 3600_000);
    if (startsAt) {
      const floor = Math.max(startsAt.getTime() + STAY_AFTER_START_H * 3600_000, (endsAt?.getTime() ?? 0) + 3600_000);
      if (expiresAt.getTime() < floor) expiresAt = new Date(floor);
    }
    const token = randomBytes(32).toString('base64url');
    const row = await this.repo.create({
      tenantId, roomId,
      projectId: input.projectId ?? null,
      label,
      tokenHash: this.sha256(token),
      createdBy,
      expiresAt,
      maxUses: null,
      chatId: input.chatId ?? null,
      startsAt,
      eventId: input.eventId ? String(input.eventId) : null,
    });
    if (!row) throw AppException.conflict('Не удалось создать ссылку');
    return {
      id: row.id, roomId, url: `${this.baseUrl()}/meet/${token}`, expiresAt: row.expires_at,
      startsAt: row.starts_at, label: row.label,
    };
  }

  list(tenantId: string) {
    return this.repo.list(tenantId);
  }

  async revoke(tenantId: string, id: string) {
    const row = await this.repo.revoke(tenantId, id);
    if (!row) throw AppException.notFound('Ссылка не найдена');
    return { id: row.id, roomId: row.room_id, revokedAt: row.revoked_at };
  }

  /**
   * Открыть комнату выданной ссылки — вход ХОЗЯИНА.
   *
   * Без этого сценарий «отправили ссылку вчера, встреча сегодня» не работал:
   * ссылка оставалась годной, гость приходил и ждал, а сотруднику войти в ту же
   * комнату было неоткуда — в интерфейсе есть только идущие созвоны.
   */
  async open(tenantId: string, id: string) {
    const link = await this.repo.findActive(tenantId, id);
    if (!link) throw AppException.notFound('Ссылка не найдена или больше не действует');
    const room = await this.media.ensureRoom(tenantId, link.room_id, link.project_id);
    return { roomId: room.id, projectId: room.projectId, label: link.label };
  }

  /**
   * Разбор ссылки без побочных действий — для экрана «вы приглашены».
   *
   * Поле называется `valid`, а не `ok`, намеренно: конвертом ответа служит
   * `{ok, data}`, и объект с собственным `ok` проходит через обёртку насквозь —
   * клиент получил бы пустой `data` вместо ответа.
   */
  async describe(token: string): Promise<
    | {
      valid: true; orgName: string; label: string | null; roomActive: boolean; hostPresent: boolean;
      /** Время встречи и момент, с которого можно войти (ISO); null — открыто сразу. */
      startsAt: string | null; opensAt: string | null;
      /** За ссылкой есть переписка: до встречи гостя пускают в неё, но не в созвон. */
      hasChat: boolean;
      /** Персональное приглашение по email — как зовут гостя. */
      invitedAs: string | null;
    }
    | { valid: false; reason: LinkRefusal }
  > {
    const link = await this.repo.findByHash(this.sha256(String(token || '')));
    if (!link) return { valid: false, reason: 'unknown' };
    const refusal = this.refusalFor(link);
    if (refusal) return { valid: false, reason: refusal };

    const room = this.media.getRoom(link.room_id);
    return {
      valid: true,
      orgName: link.tenant_name,
      label: link.label,
      roomActive: !!room,
      // «хозяин на месте» = есть хотя бы один не-гость: впустить может только сотрудник
      hostPresent: !!room && [...room.participants.keys()].some((id) => !id.startsWith('guest:')),
      startsAt: link.starts_at ? new Date(link.starts_at).toISOString() : null,
      opensAt: link.starts_at ? GuestLinksService.opensAt(link.starts_at, link.early_join_min).toISOString() : null,
      hasChat: !!link.chat_id,
      // персональное приглашение: «Вы приглашены как John Smith» (ТЗ-14, §67)
      invitedAs: link.invite_email ? (link.invite_name || link.invite_email) : null,
    };
  }

  /** Свой ли сотрудник комнате ссылки/события — входит без стука. */
  isRoomMember(tenantId: string, roomId: string, userId: string): Promise<boolean> {
    if (!/^\d+$/.test(String(userId))) return Promise.resolve(false); // гость — не сотрудник
    return this.repo.isRoomMember(tenantId, roomId, String(userId));
  }

  // ───────────── Персональные приглашения гостям по email (ТЗ-14, §66–70, §112) ─────────────

  private inviteView(r: GuestLinkRow & { invite_email?: string | null; invite_name?: string | null; invited_at?: Date | null }) {
    return {
      id: String(r.id), email: r.invite_email, name: r.invite_name ?? null,
      invitedAt: r.invited_at, active: !r.revoked_at && new Date(r.expires_at).getTime() > Date.now(),
      revokedAt: r.revoked_at, opened: r.uses > 0, lastUsedAt: r.last_used_at,
    };
  }

  private async manageable(user: { userId: string; tenantId: string }, eventId: string) {
    const ev = await this.repo.eventForInvite(user.tenantId, eventId, user.userId);
    if (!ev) throw AppException.notFound('Встреча не найдена');
    if (!ev.can_manage) throw AppException.forbidden('Гостей зовёт организатор или соорганизатор встречи');
    if (!ev.is_call || !ev.meet_room_id) throw AppException.conflict('Включите у встречи «Созвон» — тогда гостю будет куда войти');
    return ev;
  }

  /** Список приглашённых гостей встречи. */
  async listInvites(user: { userId: string; tenantId: string }, eventId: string) {
    await this.manageable(user, eventId);
    return (await this.repo.invitesOf(user.tenantId, eventId)).map((r) => this.inviteView(r));
  }

  /**
   * Пригласить гостя по email: своя ссылка, письмо с файлом встречи.
   *
   * Ссылка у каждого гостя своя: отозвать можно одного, не трогая остальных, и
   * страница встречает его по имени. Тот же адрес уже приглашён — старая ссылка
   * отзывается, уходит новая: «отправить ещё раз» без двух живых ссылок на одного человека.
   */
  async inviteGuest(user: { userId: string; tenantId: string }, eventId: string, emailRaw: string, nameRaw?: string | null) {
    const ev = await this.manageable(user, eventId);
    const email = String(emailRaw || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) throw AppException.validation('Проверьте адрес почты гостя');
    const name = String(nameRaw || '').trim().slice(0, 120) || null;
    for (const old of await this.repo.invitesOf(user.tenantId, eventId)) {
      if (old.invite_email === email && !old.revoked_at) await this.repo.revoke(user.tenantId, String(old.id));
    }
    const token = randomBytes(32).toString('base64url');
    const row = await this.repo.createInvite({
      tenantId: user.tenantId, roomId: ev.meet_room_id!, eventId, createdBy: user.userId,
      tokenHash: this.sha256(token), tokenEnc: this.crypto.encrypt(token), email, name,
      startsAt: new Date(ev.starts_at), endsAt: new Date(ev.ends_at), earlyJoinMin: ev.early_join_min ?? OPEN_BEFORE_MIN,
    });
    if (!row) throw AppException.conflict('Не удалось создать приглашение');
    await this.mail.sendGuest('invite', ev, { inviteId: String(row.id), email, name, url: `${this.baseUrl()}/meet/${token}` }, ev.owner_name);
    this.log.log(`гость ${email} приглашён на встречу ${eventId}`);
    return { ...this.inviteView(row), url: `${this.baseUrl()}/meet/${token}` };
  }

  /** «Отправить ещё раз» — та же ссылка, новое письмо. */
  async resendInvite(user: { userId: string; tenantId: string }, eventId: string, inviteId: string) {
    const ev = await this.manageable(user, eventId);
    const inv = await this.repo.inviteById(user.tenantId, inviteId);
    if (!inv || String(inv.event_id) !== String(eventId) || inv.revoked_at || !inv.token_enc) throw AppException.notFound('Приглашение не найдено');
    const url = `${this.baseUrl()}/meet/${this.crypto.decrypt(inv.token_enc)}`;
    // повтор приглашения — новое письмо, а не «уже отправлено»: ключ письма уникален
    await this.mail.sendGuest('update', ev, { inviteId: `${inv.id}:${Date.now()}`, email: inv.invite_email, name: inv.invite_name, url }, ev.owner_name);
    return this.inviteView(inv);
  }

  /** Отозвать приглашение: ссылка скажет «приглашение больше не активно», гостя — из комнаты. */
  async revokeInvite(user: { userId: string; tenantId: string }, eventId: string, inviteId: string) {
    await this.manageable(user, eventId);
    const inv = await this.repo.inviteById(user.tenantId, inviteId);
    if (!inv || String(inv.event_id) !== String(eventId)) throw AppException.notFound('Приглашение не найдено');
    await this.repo.revoke(user.tenantId, inviteId);
    return { id: String(inv.id), roomId: inv.room_id };
  }

  /** Напомнить гостям за 15 минут — по их же ссылке (§38). Зовёт планировщик. */
  async remindGuests(): Promise<number> {
    let sent = 0;
    for (const inv of await this.repo.dueGuestReminders(15)) {
      if (!(await this.repo.markGuestReminded(String(inv.id)))) continue;
      const ev = await this.repo.eventForInvite(String(inv.tenant_id), String(inv.event_id), String(inv.created_by)).catch(() => null);
      if (!ev || !inv.token_enc) continue;
      await this.mail.sendGuest('reminder', ev, {
        inviteId: String(inv.id), email: inv.invite_email, name: inv.invite_name,
        url: `${this.baseUrl()}/meet/${this.crypto.decrypt(inv.token_enc)}`,
      }, ev.owner_name);
      sent++;
    }
    return sent;
  }

  /** С какого момента гостя пускают постучаться. `early` — ранний вход встречи, минут. */
  static opensAt(startsAt: Date | string, early = OPEN_BEFORE_MIN): Date {
    return new Date(new Date(startsAt).getTime() - early * 60_000);
  }

  /** Рано ли стучаться по ссылке с этим временем встречи. */
  static tooEarly(startsAt: Date | string | null, now = Date.now(), early = OPEN_BEFORE_MIN): boolean {
    return !!startsAt && now < GuestLinksService.opensAt(startsAt, early).getTime();
  }

  // ───────────────────── Встреча по постоянной ссылке (ТЗ-14) ─────────────────────

  /**
   * Состояние встречи — считается от времени на СЕРВЕРЕ при каждом вопросе, а не хранится.
   *
   * Так «пропущенный переход» (§101 ТЗ) невозможен по построению: никакого задания,
   * которое в 09:00 должно перевести встречу в OPEN, нет — в 09:00 она просто OPEN.
   */
  static meetingState(link: Partial<Pick<GuestLinkRow, 'starts_at' | 'revoked_at' | 'cancelled_at' | 'ended_at' | 'early_join_min'>> & { expires_at: Date | string }, live: boolean, now = Date.now()):
    'scheduled' | 'early' | 'open' | 'live' | 'ended' | 'cancelled' | 'unavailable' {
    if (link.cancelled_at) return 'cancelled';
    if (link.revoked_at) return 'unavailable';
    if (live) return 'live';
    if (link.ended_at || new Date(link.expires_at).getTime() <= now) return 'ended';
    if (!link.starts_at) return 'open';
    const start = new Date(link.starts_at).getTime();
    if (now >= start) return 'open';
    if (now >= start - (link.early_join_min ?? OPEN_BEFORE_MIN) * 60_000) return 'early';
    return 'scheduled';
  }

  private roomLive(roomId: string): { live: boolean; hostPresent: boolean; people: number } {
    const room = this.media.getRoom(roomId);
    const people = room ? [...room.participants.keys()] : [];
    return { live: people.length > 0, hostPresent: people.some((id) => !id.startsWith('guest:')), people: people.length };
  }

  /**
   * Страница встречи — открытая часть: то, что видно любому, у кого есть ссылка.
   * Участников по именам здесь нет: их показывает `meetingForUser` своим.
   */
  async describeMeeting(publicId: string) {
    const link = await this.repo.meetingByPublicId(String(publicId || '').slice(0, 16));
    if (!link) return { valid: false as const, reason: 'unknown' as const };
    const room = this.roomLive(link.room_id);
    const state = GuestLinksService.meetingState(link, room.live);
    return {
      valid: true as const,
      state,
      title: link.event_title ?? link.label ?? 'Встреча',
      orgName: link.tenant_name,
      organizer: link.organizer_name,
      startsAt: link.starts_at ? new Date(link.starts_at).toISOString() : null,
      endsAt: link.ends_at ? new Date(link.ends_at).toISOString() : null,
      opensAt: link.starts_at ? GuestLinksService.opensAt(link.starts_at, link.early_join_min).toISOString() : null,
      earlyJoinMin: link.early_join_min ?? OPEN_BEFORE_MIN,
      accessPolicy: link.access_policy ?? 'trusted',
      guestsAllowed: link.guests_allowed !== false,
      hostPresent: room.hostPresent,
      people: room.people,
      // часы сервера: отсчёт на странице не должен зависеть от сбитых часов телефона (§100)
      serverNow: new Date().toISOString(),
    };
  }

  /** Своя часть страницы встречи: кто приглашён и кем ты в ней приходишься. */
  async meetingForUser(publicId: string, user: { userId: string; tenantId: string }) {
    const link = await this.repo.meetingByPublicId(String(publicId || '').slice(0, 16));
    if (!link || String(link.tenant_id) !== String(user.tenantId)) return { member: false as const };
    const people = await this.repo.meetingPeople(String(link.tenant_id), link.event_id ? String(link.event_id) : null);
    const me = people.find((p) => p.user_id === String(user.userId));
    const role = String(link.created_by) === String(user.userId) || me?.is_organizer ? 'organizer'
      : me?.is_co_organizer ? 'co_organizer' : me && me.status !== 'declined' ? 'participant' : 'employee';
    return {
      member: true as const,
      role,
      roomId: link.room_id,
      eventId: link.event_id ? String(link.event_id) : null,
      people: people.map((p) => ({
        userId: p.user_id, name: p.full_name, status: p.status,
        role: p.is_organizer ? 'organizer' : p.is_co_organizer ? 'co_organizer' : 'participant',
      })),
    };
  }

  /**
   * Сотрудник жмёт «Войти» на странице встречи.
   *
   * Комнату поднимаем здесь же: раньше её поднимал только гость, и сотрудник, пришедший
   * первым по кнопке «Войти в созвон», получал «Созвон не найден» (баг, найденный при
   * разборе ТЗ-14). Пускать ли внутрь — решает шлюз по правилам встречи.
   */
  async enterMeeting(publicId: string, user: { userId: string; tenantId: string }) {
    const link = await this.repo.meetingByPublicId(String(publicId || '').slice(0, 16));
    if (!link || String(link.tenant_id) !== String(user.tenantId)) throw AppException.notFound('Встреча не найдена');
    const state = GuestLinksService.meetingState(link, this.roomLive(link.room_id).live);
    if (state === 'cancelled') throw AppException.conflict('Встреча отменена');
    if (state === 'unavailable') throw AppException.conflict('У этой встречи больше нет созвона');
    // не поднялась сейчас (медиасервер перезапускается) — шлюз поднимет её при подключении сам
    await this.media.ensureRoom(String(link.tenant_id), link.room_id, link.project_id ?? null).catch((e) => {
      this.log.warn(`комната встречи ${link.room_id} не поднялась заранее: ${(e as Error).message}`);
    });
    return { roomId: link.room_id, state };
  }

  /** Гость по общей ссылке встречи: имя — и в зал ожидания (решение заказчика 05.10: гости остаются). */
  async joinMeetingAsGuest(publicId: string, name: string) {
    const link = await this.repo.meetingByPublicId(String(publicId || '').slice(0, 16));
    if (!link) throw AppException.notFound('Встреча не найдена');
    const state = GuestLinksService.meetingState(link, this.roomLive(link.room_id).live);
    if (state === 'cancelled') throw AppException.conflict('Встреча отменена');
    if (state === 'ended') throw AppException.conflict('Встреча завершена');
    if (state === 'unavailable') throw AppException.conflict('У этой встречи больше нет созвона');
    if (link.guests_allowed === false) throw AppException.forbidden('На эту встречу входят только приглашённые');
    if (state === 'scheduled') {
      throw AppException.validation(`Войти можно будет за ${link.early_join_min ?? OPEN_BEFORE_MIN} минут до начала`);
    }
    return this.issueGuest(link, name);
  }

  /**
   * Пускать ли сотрудника во встречу — по её правилам (ТЗ-14, §23–28).
   *
   * - организатор и соорганизаторы — всегда (и могут «начать раньше»);
   * - до раннего входа — рано: участник видит отсчёт;
   * - участник: trusted — сразу с начала или как только пришёл организатор,
   *   до начала — в зал ожидания; host_required — только при организаторе внутри;
   *   waiting_room — всегда через зал;
   * - коллега, которого не звали, — стучится (как было).
   * null — комната не встречи: решает старое правило.
   */
  async meetingAccess(tenantId: string, roomId: string, userId: string, hostInside: boolean):
    Promise<null | { verdict: 'direct' | 'knock' | 'early' | 'closed'; host: boolean; reason?: string; opensAt?: string }> {
    const link = await this.repo.meetingOfRoom(tenantId, roomId).catch(() => null);
    if (!link) return null;
    const people = await this.repo.meetingPeople(tenantId, link.event_id ? String(link.event_id) : null);
    const me = people.find((p) => p.user_id === String(userId));
    const host = String(link.created_by) === String(userId) || !!me?.is_organizer || !!me?.is_co_organizer;
    const state = GuestLinksService.meetingState(link, false);
    if (state === 'cancelled' || state === 'unavailable') return { verdict: 'closed', host, reason: state };
    if (host) {
      // организатор вошёл после «Завершить для всех» — встреча снова открыта
      if (link.ended_at) await this.repo.setEnded(String(link.id), false);
      return { verdict: 'direct', host };
    }
    if (state === 'ended') return { verdict: 'closed', host, reason: 'ended' };
    if (state === 'scheduled' && !hostInside) {
      return { verdict: 'early', host, opensAt: link.starts_at ? GuestLinksService.opensAt(link.starts_at, link.early_join_min).toISOString() : undefined };
    }
    const participant = !!me && me.status !== 'declined';
    if (!participant) return { verdict: 'knock', host };
    const policy = link.access_policy ?? 'trusted';
    if (policy === 'waiting_room') return { verdict: 'knock', host };
    if (policy === 'host_required') return { verdict: hostInside ? 'direct' : 'knock', host };
    return { verdict: state === 'open' || hostInside ? 'direct' : 'knock', host };
  }

  /** Организатор ли этот сотрудник в комнате встречи (для «Завершить для всех» и «Закрыть вход»). */
  async isMeetingHost(tenantId: string, roomId: string, userId: string): Promise<boolean | null> {
    const link = await this.repo.meetingOfRoom(tenantId, roomId).catch(() => null);
    if (!link) return null;
    if (String(link.created_by) === String(userId)) return true;
    const people = await this.repo.meetingPeople(tenantId, link.event_id ? String(link.event_id) : null);
    const me = people.find((p) => p.user_id === String(userId));
    return !!me?.is_organizer || !!me?.is_co_organizer;
  }

  /** «Завершить для всех»: встреча закрыта, пока организатор не войдёт снова. */
  async endMeeting(tenantId: string, roomId: string): Promise<void> {
    const link = await this.repo.meetingOfRoom(tenantId, roomId).catch(() => null);
    if (link) await this.repo.setEnded(String(link.id), true);
  }

  /** Встреча комнаты отменена или завершена — гостю туда уже нельзя. */
  async meetingClosed(tenantId: string, roomId: string): Promise<string | null> {
    const link = await this.repo.meetingOfRoom(tenantId, roomId).catch(() => null);
    if (!link) return null;
    const state = GuestLinksService.meetingState(link, !!this.media.getRoom(roomId)?.participants.size);
    return state === 'cancelled' || state === 'ended' || state === 'unavailable' ? state : null;
  }

  /** Есть ли у комнаты живая ссылка — тогда её можно поднять по первому входу. */
  roomHasLink(tenantId: string, roomId: string): Promise<boolean> {
    return this.repo.roomOpen(tenantId, roomId).catch(() => false);
  }

  /**
   * Когда гостю можно стучаться, если ещё рано (ISO), иначе null.
   * Шлюз спрашивает в момент стука: токен выдают и раньше — ради переписки.
   */
  async opensLater(tenantId: string, roomId: string, linkId?: string): Promise<string | null> {
    const link = await this.repo.activeForRoom(tenantId, roomId, linkId).catch(() => null);
    if (!link || !GuestLinksService.tooEarly(link.starts_at, Date.now(), link.early_join_min)) return null;
    return GuestLinksService.opensAt(link.starts_at as Date, link.early_join_min).toISOString();
  }

  /**
   * Гость постучал, а в комнате ни одного сотрудника — позвать хозяина.
   *
   * Это ровно та дыра, из-за которой «отправили ссылку — гость не смог подключиться»:
   * стук слышат только те, кто внутри. Зовём автора ссылки и сотрудников события.
   * До времени встречи не зовём: гость пришёл рано, будить людей рано, а ему самому
   * страница показывает отсчёт. Возвращает, позвали ли.
   */
  async callHost(tenantId: string, roomId: string, guestName: string, linkId?: string, waiting = 1, late = false): Promise<boolean> {
    const link = await this.repo.activeForRoom(tenantId, roomId, linkId).catch(() => null);
    if (!link || GuestLinksService.tooEarly(link.starts_at, Date.now(), link.early_join_min)) return false;
    const last = this.hostCalledAt.get(roomId) ?? 0;
    if (Date.now() - last < HOST_CALL_EVERY_MS) return true;
    this.hostCalledAt.set(roomId, Date.now());
    const what = link.label ? `«${link.label}»` : 'по внешней ссылке';
    // несколько ждущих — одно уведомление «ждут N», а не N уведомлений (ТЗ-14, §36)
    const lateMin = late && link.starts_at ? Math.max(0, Math.round((Date.now() - new Date(link.starts_at).getTime()) / 60_000)) : 0;
    await this.notifyHosts(link, 'meet.guest-waiting', {
      title: late
        ? `Встреча ${what} должна была начаться ${lateMin} мин назад`
        : waiting > 1 ? `В зале ожидания ${waiting} чел.` : `Ждёт в созвоне: ${guestName}`,
      body: late
        ? `Ждут ${waiting} чел. Войдите и начните встречу.`
        : `Встреча ${what}. В комнате никого из команды — войдите и впустите.`,
      guestName,
    });
    return true;
  }

  /**
   * Напомнить открыть комнату перед встречей — зовёт планировщик раз в минуту.
   * Отметка ставится ДО отправки: лучше одно потерянное напоминание, чем десять.
   */
  async remindDue(): Promise<number> {
    let sent = 0;
    for (const link of await this.repo.dueReminders(REMIND_BEFORE_MIN)) {
      if (!(await this.repo.markReminded(link.id))) continue;
      const at = link.starts_at ? new Date(link.starts_at).getTime() : Date.now();
      const what = link.label ? `«${link.label}»` : 'с гостем по внешней ссылке';
      const left = Math.round((at - Date.now()) / 60_000);
      await this.notifyHosts(link, 'meet.guest-soon', {
        title: `Скоро встреча ${what}`,
        body: `${left > 0 ? `Начало через ${left} мин.` : 'Время встречи наступило.'} `
          + 'Откройте комнату: гость сможет войти, только когда внутри есть кто-то из команды.',
        guestName: null,
      });
      sent++;
    }
    return sent;
  }

  /**
   * Кого звать и как. Всплывашка с кнопкой «Войти» — тем, у кого открыто приложение;
   * ящик и push — телефону; Telegram — тому, кто не сидит ни там, ни там. Ошибка
   * одного канала не отменяет остальные.
   */
  private async notifyHosts(
    link: HostCallRow, eventKey: 'meet.guest-waiting' | 'meet.guest-soon',
    msg: { title: string; body: string; guestName: string | null },
  ): Promise<void> {
    const tenantId = String(link.tenant_id);
    const people = new Set<string>([String(link.created_by)]);
    if (link.event_id) {
      for (const id of await this.repo.eventPeople(tenantId, String(link.event_id)).catch(() => [])) people.add(id);
    }
    const ids = [...people];
    this.realtime.emitToUsers(tenantId, ids, 'meet.guest-call-host', {
      kind: eventKey === 'meet.guest-waiting' ? 'waiting' : 'soon',
      linkId: String(link.id), roomId: link.room_id, label: link.label,
      guestName: msg.guestName, title: msg.title, body: msg.body,
    });
    for (const userId of ids) {
      await this.push.meetHost({ tenantId, userId, eventKey, title: msg.title, body: msg.body });
      await this.telegram.push(tenantId, userId, `${msg.title}\n${msg.body}\n${this.baseUrl()}/chat`);
    }
    this.log.log(`${eventKey}: позвали ${ids.length} чел. в комнату ${link.room_id}`);
  }

  /**
   * Вход по ссылке: выдаём гостевой токен, привязанный к одной комнате.
   * Комнату здесь же поднимаем — иначе гость, пришедший первым, увидит «созвон не найден».
   */
  async join(token: string, name: string) {
    const link = await this.repo.findByHash(this.sha256(String(token || '')));
    if (!link) throw AppException.unauthorized('Ссылка недействительна');
    const refusal = this.refusalFor(link);
    if (refusal) throw AppException.unauthorized(this.refusalMessage(refusal));

    /*
      До встречи пускаем только в переписку: в созвон рано, а ссылка «только на созвон»
      ничего, кроме него, не даёт. Страница сама показывает время и отсчёт — это отказ
      на случай, если её обошли.
    */
    if (!link.chat_id && GuestLinksService.tooEarly(link.starts_at, Date.now(), link.early_join_min)) {
      throw AppException.validation(`Вход откроется за ${link.early_join_min ?? OPEN_BEFORE_MIN} минут до начала встречи`);
    }
    return this.issueGuest(link, name);
  }

  /** Гостевой токен на одну комнату — для гостевой ссылки и для общей ссылки встречи. */
  private async issueGuest(link: GuestLinkRow, name: string) {
    const guestName = String(name || '').trim().slice(0, 60);
    if (guestName.length < 2) throw AppException.validation('Представьтесь, пожалуйста');
    const gid = randomUUID();
    const payload: GuestTokenPayload = {
      kind: 'guest', gid, tenantId: link.tenant_id, roomId: link.room_id, name: guestName,
      chatId: link.chat_id ? String(link.chat_id) : null,
      linkId: String(link.id),
    };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      expiresIn: GUEST_TOKEN_TTL_SEC,
    });
    await this.repo.markUsed(link.id);
    this.log.log(`гость «${guestName}» получил доступ в комнату ${link.room_id}`);

    return {
      token: accessToken,
      roomId: link.room_id,
      name: guestName,
      // чат ссылки: гость попадает и в переписку, а не только в переговорную
      chatId: link.chat_id ? String(link.chat_id) : null,
      // тот же id, под которым гость появится в комнате: по нему браузер отличает свои потоки
      userId: `guest:${gid}`,
      // ICE берём тем же способом, что и для сотрудников: гостю TURN нужнее всех —
      // он сидит в мобильной сети или за корпоративным NAT
      iceServers: this.media.iceServers(`guest:${gid}`),
      startsAt: link.starts_at ? new Date(link.starts_at).toISOString() : null,
      opensAt: link.starts_at ? GuestLinksService.opensAt(link.starts_at, link.early_join_min).toISOString() : null,
    };
  }

  /** Проверка гостевого токена — для шлюза сигналинга. */
  verify(token: string): GuestTokenPayload | null {
    try {
      const payload = this.jwt.verify<GuestTokenPayload>(token, {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      });
      return payload?.kind === 'guest' && payload.roomId && payload.tenantId ? payload : null;
    } catch {
      return null;
    }
  }

  /** Отозвана ли ссылка на эту комнату прямо сейчас — гостя нужно выставить немедленно. */
  async roomStillOpen(tenantId: string, roomId: string): Promise<boolean> {
    // и гостевые ссылки, и ссылка встречи: гость встречи пришёл по ней
    return this.repo.roomOpen(tenantId, roomId);
  }

  private refusalFor(link: { revoked_at: Date | null; expires_at: Date; max_uses: number | null; uses: number; cancelled_at?: Date | null; invite_email?: string | null }): LinkRefusal | null {
    // встречу отменили — так и говорим; личное приглашение отозвали — «больше не активно» (ТЗ-14, §52)
    if (link.cancelled_at) return 'cancelled';
    if (link.revoked_at) return link.invite_email ? 'invite-revoked' : 'revoked';
    if (new Date(link.expires_at).getTime() <= Date.now()) return 'expired';
    if (link.max_uses !== null && link.uses >= link.max_uses) return 'used-up';
    return null;
  }

  private refusalMessage(reason: LinkRefusal): string {
    if (reason === 'revoked') return 'Ссылку отозвали — попросите новую';
    if (reason === 'invite-revoked') return 'Ваше приглашение больше не активно';
    if (reason === 'cancelled') return 'Встреча отменена';
    if (reason === 'expired') return 'Срок ссылки истёк — попросите новую';
    if (reason === 'used-up') return 'Ссылкой уже воспользовались';
    return 'Ссылка недействительна';
  }

  private baseUrl(): string {
    return (this.config.get<string>('APP_BASE_URL') || 'https://qevo.one').replace(/\/+$/, '');
  }
}
