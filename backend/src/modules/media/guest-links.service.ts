import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { AppException } from '../../common/http/app-exception';
import { RealtimeService } from '../realtime/realtime.service';
import { PushService } from '../notifications/push.service';
import { TelegramMirror } from '../notifications/telegram-mirror.service';
import { GuestLinksRepository, HostCallRow } from './guest-links.repository';
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

export type LinkRefusal = 'unknown' | 'revoked' | 'expired' | 'used-up';

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
      opensAt: link.starts_at ? GuestLinksService.opensAt(link.starts_at).toISOString() : null,
      hasChat: !!link.chat_id,
    };
  }

  /** Свой ли сотрудник комнате ссылки/события — входит без стука. */
  isRoomMember(tenantId: string, roomId: string, userId: string): Promise<boolean> {
    if (!/^\d+$/.test(String(userId))) return Promise.resolve(false); // гость — не сотрудник
    return this.repo.isRoomMember(tenantId, roomId, String(userId));
  }

  /** С какого момента гостя пускают постучаться. */
  static opensAt(startsAt: Date | string): Date {
    return new Date(new Date(startsAt).getTime() - OPEN_BEFORE_MIN * 60_000);
  }

  /** Рано ли стучаться по ссылке с этим временем встречи. */
  static tooEarly(startsAt: Date | string | null, now = Date.now()): boolean {
    return !!startsAt && now < GuestLinksService.opensAt(startsAt).getTime();
  }

  /**
   * Когда гостю можно стучаться, если ещё рано (ISO), иначе null.
   * Шлюз спрашивает в момент стука: токен выдают и раньше — ради переписки.
   */
  async opensLater(tenantId: string, roomId: string, linkId?: string): Promise<string | null> {
    const link = await this.repo.activeForRoom(tenantId, roomId, linkId).catch(() => null);
    if (!link || !GuestLinksService.tooEarly(link.starts_at)) return null;
    return GuestLinksService.opensAt(link.starts_at as Date).toISOString();
  }

  /**
   * Гость постучал, а в комнате ни одного сотрудника — позвать хозяина.
   *
   * Это ровно та дыра, из-за которой «отправили ссылку — гость не смог подключиться»:
   * стук слышат только те, кто внутри. Зовём автора ссылки и сотрудников события.
   * До времени встречи не зовём: гость пришёл рано, будить людей рано, а ему самому
   * страница показывает отсчёт. Возвращает, позвали ли.
   */
  async callHost(tenantId: string, roomId: string, guestName: string, linkId?: string): Promise<boolean> {
    const link = await this.repo.activeForRoom(tenantId, roomId, linkId).catch(() => null);
    if (!link || GuestLinksService.tooEarly(link.starts_at)) return false;
    const last = this.hostCalledAt.get(roomId) ?? 0;
    if (Date.now() - last < HOST_CALL_EVERY_MS) return true;
    this.hostCalledAt.set(roomId, Date.now());
    const what = link.label ? `«${link.label}»` : 'по внешней ссылке';
    await this.notifyHosts(link, 'meet.guest-waiting', {
      title: `Гость ждёт в созвоне: ${guestName}`,
      body: `Встреча ${what}. В комнате никого из команды — войдите и впустите гостя.`,
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

    const guestName = String(name || '').trim().slice(0, 60);
    if (guestName.length < 2) throw AppException.validation('Представьтесь, пожалуйста');
    /*
      До встречи пускаем только в переписку: в созвон рано, а ссылка «только на созвон»
      ничего, кроме него, не даёт. Страница сама показывает время и отсчёт — это отказ
      на случай, если её обошли.
    */
    if (!link.chat_id && GuestLinksService.tooEarly(link.starts_at)) {
      throw AppException.validation(`Вход откроется за ${OPEN_BEFORE_MIN} минут до начала встречи`);
    }

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
      opensAt: link.starts_at ? GuestLinksService.opensAt(link.starts_at).toISOString() : null,
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
    const rows = await this.repo.list(tenantId);
    return rows.some((r) => r.room_id === roomId);
  }

  private refusalFor(link: { revoked_at: Date | null; expires_at: Date; max_uses: number | null; uses: number }): LinkRefusal | null {
    if (link.revoked_at) return 'revoked';
    if (new Date(link.expires_at).getTime() <= Date.now()) return 'expired';
    if (link.max_uses !== null && link.uses >= link.max_uses) return 'used-up';
    return null;
  }

  private refusalMessage(reason: LinkRefusal): string {
    if (reason === 'revoked') return 'Ссылку отозвали — попросите новую';
    if (reason === 'expired') return 'Срок ссылки истёк — попросите новую';
    if (reason === 'used-up') return 'Ссылкой уже воспользовались';
    return 'Ссылка недействительна';
  }

  private baseUrl(): string {
    return (this.config.get<string>('APP_BASE_URL') || 'https://anthill.team').replace(/\/+$/, '');
  }
}
