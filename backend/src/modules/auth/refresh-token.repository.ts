import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface RefreshTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
  user_agent: string | null;
  ip: string | null;
  last_used_at: Date | null;
  device_id?: string | null;
}

/** Сессия с устройством, если вход был из мобильной оболочки (ТЗ-9). */
export interface SessionRow extends RefreshTokenRow {
  device_platform: string | null;
  device_model: string | null;
  device_native_version: string | null;
  device_bundle_version: string | null;
}

@Injectable()
export class RefreshTokenRepository {
  constructor(private readonly db: DbService) {}

  create(
    userId: string,
    tokenHash: string,
    expiresAt: Date,
    meta?: { userAgent?: string; ip?: string },
  ): Promise<RefreshTokenRow> {
    return this.db.one<RefreshTokenRow>(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip, last_used_at)
       VALUES ($1, $2, $3, $4, $5, now()) RETURNING *`,
      [userId, tokenHash, expiresAt, meta?.userAgent ?? null, meta?.ip ?? null],
    ) as Promise<RefreshTokenRow>;
  }

  findActiveByHash(tokenHash: string) {
    return this.db.one<RefreshTokenRow>(
      `SELECT * FROM refresh_tokens
        WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [tokenHash],
    );
  }

  revoke(id: string) {
    return this.db.query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
      [id],
    );
  }

  revokeByHash(tokenHash: string) {
    return this.db.query(
      `UPDATE refresh_tokens SET revoked_at = now()
        WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash],
    );
  }

  // --- session management (Этап C) ---
  listActive(userId: string) {
    return this.db.many<SessionRow>(
      `SELECT r.*, d.platform AS device_platform, d.model AS device_model,
              d.native_version AS device_native_version, d.web_bundle_version AS device_bundle_version
         FROM refresh_tokens r
         LEFT JOIN mobile_devices d ON d.id = r.device_id
        WHERE r.user_id=$1 AND r.revoked_at IS NULL AND r.expires_at > now()
        ORDER BY COALESCE(r.last_used_at, r.created_at) DESC`,
      [userId],
    );
  }

  /** Сотрудник этой организации? Список чужих сессий не отдаём даже пустым. */
  async userInTenant(tenantId: string, userId: string): Promise<boolean> {
    const row = await this.db.one<{ id: string }>(
      `SELECT id FROM users WHERE id=$1 AND tenant_id=$2`, [userId, tenantId],
    );
    return !!row;
  }

  revokeOwned(userId: string, id: string) {
    return this.db.query(
      `UPDATE refresh_tokens SET revoked_at=now()
        WHERE user_id=$1 AND id=$2 AND revoked_at IS NULL`,
      [userId, id],
    );
  }

  revokeAllExcept(userId: string, exceptId?: string) {
    return this.db.query(
      `UPDATE refresh_tokens SET revoked_at=now()
        WHERE user_id=$1 AND revoked_at IS NULL AND ($2::bigint IS NULL OR id <> $2)`,
      [userId, exceptId ?? null],
    );
  }

  touch(id: string) {
    return this.db.query(`UPDATE refresh_tokens SET last_used_at=now() WHERE id=$1`, [id]);
  }
}
