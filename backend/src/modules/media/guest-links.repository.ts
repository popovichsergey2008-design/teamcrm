import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface GuestLinkRow {
  id: string;
  tenant_id: string;
  room_id: string;
  project_id: string | null;
  label: string | null;
  created_by: string;
  expires_at: Date;
  revoked_at: Date | null;
  max_uses: number | null;
  uses: number;
  last_used_at: Date | null;
  created_at: Date;
}

@Injectable()
export class GuestLinksRepository {
  constructor(private readonly db: DbService) {}

  create(input: {
    tenantId: string; roomId: string; projectId: string | null; label: string | null;
    tokenHash: string; createdBy: string; expiresAt: Date; maxUses: number | null;
  }): Promise<GuestLinkRow | null> {
    return this.db.one<GuestLinkRow>(
      `INSERT INTO meet_guest_links
         (tenant_id, room_id, project_id, label, token_hash, created_by, expires_at, max_uses)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [input.tenantId, input.roomId, input.projectId, input.label, input.tokenHash,
        input.createdBy, input.expiresAt, input.maxUses],
    );
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
      `SELECT l.id, l.room_id, l.project_id, l.label, l.expires_at, l.revoked_at,
              l.max_uses, l.uses, l.last_used_at, l.created_at, u.full_name AS author
         FROM meet_guest_links l
         LEFT JOIN users u ON u.id = l.created_by
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
