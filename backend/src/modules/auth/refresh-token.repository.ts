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
    return this.db.many<RefreshTokenRow>(
      `SELECT * FROM refresh_tokens
        WHERE user_id=$1 AND revoked_at IS NULL AND expires_at > now()
        ORDER BY COALESCE(last_used_at, created_at) DESC`,
      [userId],
    );
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
