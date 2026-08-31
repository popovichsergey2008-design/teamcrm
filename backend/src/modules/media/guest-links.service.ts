import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { AppException } from '../../common/http/app-exception';
import { GuestLinksRepository } from './guest-links.repository';
import { MediaService } from './media.service';

/** Токен гостя живёт заметно меньше ссылки: ссылку присылают заранее, входят один раз. */
const GUEST_TOKEN_TTL_SEC = 4 * 60 * 60;
const DEFAULT_TTL_HOURS = 24;
const MAX_TTL_HOURS = 30 * 24;

/** Что лежит в гостевом JWT. Намеренно НЕ совместимо с AccessTokenPayload. */
export interface GuestTokenPayload {
  kind: 'guest';
  gid: string;
  tenantId: string;
  roomId: string;
  name: string;
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
  ) {}

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
    },
  ) {
    const roomId = input.roomId?.trim() || randomUUID();
    // чужую комнату в ссылку не заворачиваем: id угадать нельзя, но проверить дёшево
    if (input.roomId) {
      const room = this.media.getRoom(roomId);
      if (room && room.tenantId !== tenantId) throw AppException.notFound('Созвон не найден');
    }
    const hours = Math.min(Math.max(Number(input.ttlHours) || DEFAULT_TTL_HOURS, 1), MAX_TTL_HOURS);
    const token = randomBytes(32).toString('base64url');
    const row = await this.repo.create({
      tenantId, roomId,
      projectId: input.projectId ?? null,
      label: input.label?.trim()?.slice(0, 120) || null,
      tokenHash: this.sha256(token),
      createdBy,
      expiresAt: new Date(Date.now() + hours * 3600_000),
      maxUses: null,
      chatId: input.chatId ?? null,
    });
    if (!row) throw AppException.conflict('Не удалось создать ссылку');
    return { id: row.id, roomId, url: `${this.baseUrl()}/meet/${token}`, expiresAt: row.expires_at };
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
    | { valid: true; orgName: string; label: string | null; roomActive: boolean; hostPresent: boolean }
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
    };
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

    const gid = randomUUID();
    const payload: GuestTokenPayload = {
      kind: 'guest', gid, tenantId: link.tenant_id, roomId: link.room_id, name: guestName,
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
      // тот же id, под которым гость появится в комнате: по нему браузер отличает свои потоки
      userId: `guest:${gid}`,
      // ICE берём тем же способом, что и для сотрудников: гостю TURN нужнее всех —
      // он сидит в мобильной сети или за корпоративным NAT
      iceServers: this.media.iceServers(`guest:${gid}`),
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
    return (this.config.get<string>('APP_BASE_URL') || 'https://teamsmrt.com').replace(/\/+$/, '');
  }
}
