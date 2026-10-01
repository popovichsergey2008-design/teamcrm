import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface GuestLinkRow {
  id: string;
  tenant_id: string;
  room_id: string;
  project_id: string | null;
  /** Разговор, ради которого выдана ссылка: по нему гость попадает и в переписку. */
  chat_id: string | null;
  label: string | null;
  created_by: string;
  expires_at: Date;
  revoked_at: Date | null;
  max_uses: number | null;
  uses: number;
  last_used_at: Date | null;
  created_at: Date;
  /** Когда встреча: до неё гостю показываем время, а не «войдите и ждите». */
  starts_at: Date | null;
  /** Событие календаря, из которого выдана ссылка: комната у них общая. */
  event_id: string | null;
  /** Автору уже напомнили открыть комнату (раз на ссылку). */
  reminded_at: Date | null;
}

/** Ссылка, по которой надо позвать хозяина: кто выдал, для кого и на когда. */
export interface HostCallRow {
  id: string;
  tenant_id: string;
  room_id: string;
  label: string | null;
  created_by: string;
  starts_at: Date | null;
  event_id: string | null;
}

@Injectable()
export class GuestLinksRepository {
  constructor(private readonly db: DbService) {}

  create(input: {
    tenantId: string; roomId: string; projectId: string | null; label: string | null;
    tokenHash: string; createdBy: string; expiresAt: Date; maxUses: number | null;
    chatId?: string | null;
    startsAt?: Date | null; eventId?: string | null;
  }): Promise<GuestLinkRow | null> {
    return this.db.one<GuestLinkRow>(
      `INSERT INTO meet_guest_links
         (tenant_id, room_id, project_id, label, token_hash, created_by, expires_at, max_uses, chat_id,
          starts_at, event_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [input.tenantId, input.roomId, input.projectId, input.label, input.tokenHash,
        input.createdBy, input.expiresAt, input.maxUses, input.chatId ?? null,
        input.startsAt ?? null, input.eventId ?? null],
    );
  }

  /**
   * Свой ли человек комнате ссылки или события: выдал на неё ссылку, участвует в событии
   * (не отказался) или его завёл. Остальные сотрудники в такую комнату стучатся.
   */
  async isRoomMember(tenantId: string, roomId: string, userId: string): Promise<boolean> {
    const row = await this.db.one<{ ok: boolean }>(
      `SELECT (
         EXISTS (SELECT 1 FROM meet_guest_links
                  WHERE tenant_id=$1 AND room_id=$2 AND created_by=$3::bigint AND revoked_at IS NULL)
      OR EXISTS (SELECT 1 FROM calendar_events e
                  WHERE e.tenant_id=$1 AND e.meet_room_id=$2
                    AND (e.owner_id=$3::bigint OR EXISTS (
                      SELECT 1 FROM calendar_participants p
                       WHERE p.event_id=e.id AND p.user_id=$3::bigint AND p.status <> 'declined')))
       ) AS ok`,
      [tenantId, roomId, userId],
    );
    return !!row?.ok;
  }

  /** Событие календаря организации — под него выдаётся ссылка. */
  eventOf(tenantId: string, eventId: string) {
    return this.db.one<{ id: string; title: string; starts_at: Date; ends_at: Date; meet_room_id: string | null }>(
      `SELECT id, title, starts_at, ends_at, meet_room_id FROM calendar_events WHERE tenant_id=$1 AND id=$2`,
      [tenantId, eventId],
    );
  }

  /**
   * Дать событию комнату, если её ещё нет.
   *
   * Условие в самом UPDATE: двое, выдавшие ссылку одновременно, не должны развести
   * событие и гостя по разным комнатам. Возвращает ту комнату, что в итоге у события.
   */
  async setEventRoom(tenantId: string, eventId: string, roomId: string): Promise<string> {
    const row = await this.db.one<{ meet_room_id: string }>(
      `UPDATE calendar_events SET meet_room_id = COALESCE(meet_room_id, $3), updated_at = now()
        WHERE tenant_id=$1 AND id=$2 RETURNING meet_room_id`,
      [tenantId, eventId, roomId],
    );
    return row?.meet_room_id ?? roomId;
  }

  /** Действующая ссылка на комнату — самая свежая: по ней зовём того, кто её выдал. */
  activeForRoom(tenantId: string, roomId: string, linkId?: string): Promise<HostCallRow | null> {
    // ссылка гостя известна из токена — берём её; старые токены без неё — самую свежую
    return this.db.one<HostCallRow>(
      `SELECT id, tenant_id, room_id, label, created_by, starts_at, event_id
         FROM meet_guest_links
        WHERE tenant_id=$1 AND room_id=$2 AND revoked_at IS NULL AND expires_at > now()
          AND ($3::bigint IS NULL OR id = $3::bigint)
        ORDER BY created_at DESC LIMIT 1`,
      [tenantId, roomId, linkId ?? null],
    );
  }

  /** Сотрудники события, кроме отказавшихся: их тоже ждёт гость. */
  async eventPeople(tenantId: string, eventId: string): Promise<string[]> {
    const rows = await this.db.many<{ user_id: string }>(
      `SELECT user_id::text FROM calendar_participants
        WHERE tenant_id=$1 AND event_id=$2 AND status <> 'declined'`,
      [tenantId, eventId],
    );
    return rows.map((r) => r.user_id);
  }

  /** Ссылки, чья встреча вот-вот начнётся, а автору ещё не напомнили открыть комнату. */
  dueReminders(withinMinutes: number): Promise<HostCallRow[]> {
    return this.db.many<HostCallRow>(
      `SELECT id, tenant_id, room_id, label, created_by, starts_at, event_id
         FROM meet_guest_links
        WHERE starts_at IS NOT NULL AND reminded_at IS NULL AND revoked_at IS NULL
          AND expires_at > now()
          AND starts_at <= now() + make_interval(mins => $1)
          AND starts_at > now() - interval '30 minutes'
        ORDER BY starts_at LIMIT 100`,
      [withinMinutes],
    );
  }

  /** Отметка «напомнили»: условие в UPDATE — два экземпляра не напомнят дважды. */
  async markReminded(id: string): Promise<boolean> {
    const row = await this.db.one<{ id: string }>(
      `UPDATE meet_guest_links SET reminded_at = now() WHERE id=$1 AND reminded_at IS NULL RETURNING id`,
      [id],
    );
    return !!row;
  }

  /**
   * Ссылка по хэшу — БЕЗ фильтра по сроку и отзыву.
   *
   * Причину отказа гость должен видеть словами: «ссылка отозвана» и «ссылка просрочена»
   * ведут к разным действиям человека. Фильтрация в SQL превратила бы оба случая
   * в неотличимое «ссылка не найдена».
   */
  findByHash(tokenHash: string): Promise<(GuestLinkRow & { tenant_name: string }) | null> {
    return this.db.one<GuestLinkRow & { tenant_name: string }>(
      `SELECT l.*, t.name AS tenant_name
         FROM meet_guest_links l JOIN tenants t ON t.id = l.tenant_id
        WHERE l.token_hash = $1`,
      [tokenHash],
    );
  }

  async markUsed(id: string): Promise<void> {
    await this.db.query(
      `UPDATE meet_guest_links SET uses = uses + 1, last_used_at = now() WHERE id = $1`,
      [id],
    );
  }

  /** Действующая ссылка организации по номеру — для входа хозяина в ту же комнату. */
  findActive(tenantId: string, id: string): Promise<GuestLinkRow | null> {
    return this.db.one<GuestLinkRow>(
      `SELECT * FROM meet_guest_links
        WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL AND expires_at > now()`,
      [tenantId, id],
    );
  }

  list(tenantId: string) {
    return this.db.many<GuestLinkRow & { author: string | null }>(
      // Название чата — рядом со ссылкой: «для кого» без «для какого разговора»
      // через неделю превращается в загадку.
      `SELECT l.id, l.room_id, l.project_id, l.label, l.expires_at, l.revoked_at,
              l.max_uses, l.uses, l.last_used_at, l.created_at, u.full_name AS author,
              l.starts_at, l.event_id,
              l.chat_id, c.title AS chat_title, c.kind AS chat_kind
         FROM meet_guest_links l
         LEFT JOIN users u ON u.id = l.created_by
         LEFT JOIN chats c ON c.id = l.chat_id
        WHERE l.tenant_id = $1 AND l.revoked_at IS NULL AND l.expires_at > now()
        ORDER BY l.created_at DESC`,
      [tenantId],
    );
  }

  /** Отзыв идемпотентен: повторное нажатие не должно быть ошибкой. */
  revoke(tenantId: string, id: string): Promise<GuestLinkRow | null> {
    return this.db.one<GuestLinkRow>(
      `UPDATE meet_guest_links SET revoked_at = COALESCE(revoked_at, now())
        WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [tenantId, id],
    );
  }
}
