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

  /**
   * +7 дней пробного за регистрацию в Telegram-боте (#4779) — один раз на пространство,
   * только пока идёт пробный период: не оплачено, не «вечное», срок не продлевал вендор.
   * Начислили — новый конец пробного; нет — null.
   */
  async grantTrialBonus(tenantId: string, days: number): Promise<Date | null> {
    const row = await this.db.one<{ trial_ends_at: Date }>(
      `UPDATE tenants t SET trial_bonus_days = $2::int, trial_ends_at = t.trial_ends_at + make_interval(days => $2::int), updated_at = now()
        WHERE t.id = $1 AND t.trial_bonus_days = 0 AND t.trial_ends_at > now() AND NOT t.is_platform
          AND NOT EXISTS (SELECT 1 FROM tenant_subscriptions s WHERE s.tenant_id = t.id
                           AND (s.current_period_end IS NOT NULL OR s.complimentary OR s.trial_ends_at IS NOT NULL))
        RETURNING t.trial_ends_at`, [tenantId, days],
    );
    return row?.trial_ends_at ?? null;
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

  /** Чат сотрудника в Telegram. Нет привязки — писать некуда, и это нормально. */
  chatOf(tenantId: string, userId: string): Promise<{ telegram_user_id: string } | null> {
    return this.db.one<{ telegram_user_id: string }>(
      `SELECT telegram_user_id FROM telegram_accounts WHERE tenant_id=$1 AND user_id=$2`,
      [tenantId, userId],
    );
  }

  async unlink(tenantId: string, userId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM telegram_accounts WHERE tenant_id=$1 AND user_id=$2`, [tenantId, userId]);
  }

  accountByTelegram(telegramUserId: string): Promise<TgAccount | null> {
    return this.db.one<TgAccount>(
      `SELECT tenant_id, user_id, telegram_user_id FROM telegram_accounts WHERE telegram_user_id=$1`,
      [telegramUserId],
    );
  }
}
