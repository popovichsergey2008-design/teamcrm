import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface TgAccount {
  tenant_id: string;
  user_id: string;
  telegram_user_id: string;
}

@Injectable()
export class TelegramRepository {
  constructor(private readonly db: DbService) {}

  createLinkCode(tenantId: string, userId: string, code: string, expiresAt: Date) {
    return this.db.one(
      `INSERT INTO telegram_link_codes (tenant_id, user_id, code, expires_at)
       VALUES ($1,$2,$3,$4) RETURNING id, code, expires_at`,
      [tenantId, userId, code, expiresAt],
    );
  }

  findValidCode(code: string) {
    return this.db.one<{ id: string; tenant_id: string; user_id: string }>(
      `SELECT id, tenant_id, user_id FROM telegram_link_codes
        WHERE code=$1 AND used_at IS NULL AND expires_at > now()`,
      [code],
    );
  }

  async linkAccount(tenantId: string, userId: string, telegramUserId: string, codeId: string) {
    return this.db.withTransaction(async (client) => {
      await client.query(`UPDATE telegram_link_codes SET used_at=now() WHERE id=$1`, [codeId]);
      await client.query(
        `INSERT INTO telegram_accounts (tenant_id, user_id, telegram_user_id)
         VALUES ($1,$2,$3)
         ON CONFLICT (telegram_user_id) DO UPDATE SET user_id=EXCLUDED.user_id, tenant_id=EXCLUDED.tenant_id`,
        [tenantId, userId, telegramUserId],
      );
    });
  }

  accountByTelegram(telegramUserId: string): Promise<TgAccount | null> {
    return this.db.one<TgAccount>(
      `SELECT tenant_id, user_id, telegram_user_id FROM telegram_accounts WHERE telegram_user_id=$1`,
      [telegramUserId],
    );
  }
}
