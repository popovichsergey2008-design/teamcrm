import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface RefreshTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
}

@Injectable()
export class RefreshTokenRepository {
  constructor(private readonly db: DbService) {}

  create(userId: string, tokenHash: string, expiresAt: Date) {
    return this.db.one<RefreshTokenRow>(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3) RETURNING *`,
      [userId, tokenHash, expiresAt],
    );
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
}
