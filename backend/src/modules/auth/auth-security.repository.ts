import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface AccountSecurityRow {
  id: string;
  email: string;
  full_name: string;
  email_verified_at: Date | null;
  totp_secret_enc: string | null;
  totp_enabled_at: Date | null;
  totp_last_step: string | null;
}

/**
 * Данные защиты аккаунта: подтверждение почты, второй фактор, журнал входов.
 * Всё на уровне ГЛОБАЛЬНОГО аккаунта — как и пароль: один человек, одна защита
 * во всех его организациях.
 */
@Injectable()
export class AuthSecurityRepository {
  constructor(private readonly db: DbService) {}

  account(accountId: string): Promise<AccountSecurityRow | null> {
    return this.db.one<AccountSecurityRow>(
      `SELECT id::text, email, full_name, email_verified_at, totp_secret_enc, totp_enabled_at, totp_last_step::text
         FROM accounts WHERE id=$1`,
      [accountId],
    );
  }

  /** Где отправить письмо и куда писать журнал: последнее рабочее пространство, иначе первое. */
  async homeTenant(accountId: string): Promise<string | null> {
    const row = await this.db.one<{ tenant_id: string }>(
      `SELECT u.tenant_id::text FROM users u
         JOIN accounts a ON a.id = u.account_id
        WHERE u.account_id=$1 AND u.is_active
        ORDER BY (u.tenant_id = a.last_tenant_id) DESC NULLS LAST, u.id
        LIMIT 1`,
      [accountId],
    );
    return row?.tenant_id ?? null;
  }

  /** Все членства аккаунта — событие защиты аккаунта видно владельцу каждой его организации. */
  async memberships(accountId: string): Promise<{ tenant_id: string; user_id: string; full_name: string }[]> {
    return this.db.many(
      `SELECT tenant_id::text, id::text AS user_id, full_name FROM users WHERE account_id=$1 AND is_active`,
      [accountId],
    );
  }

  /** Письмо входа в общую очередь. Получатель без user_id: копий в Telegram и push не будет. */
  async enqueueMail(i: { tenantId: string; to: string; subject: string; text: string; html: string; eventKey: string; dedupKey: string }) {
    await this.db.query(
      `INSERT INTO mail_outbox (tenant_id, user_id, to_email, subject, body_text, body_html, event_key, dedup_key)
       VALUES ($1, NULL, $2, $3, $4, $5, $6, $7) ON CONFLICT (dedup_key) DO NOTHING`,
      [i.tenantId, i.to, i.subject.slice(0, 255), i.text, i.html, i.eventKey, i.dedupKey.slice(0, 160)],
    );
  }

  // ── подтверждение почты ──

  async createVerification(accountId: string, email: string, tokenHash: string, expiresAt: Date): Promise<string> {
    await this.db.query(`UPDATE email_verifications SET used_at=now() WHERE account_id=$1 AND used_at IS NULL`, [accountId]);
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO email_verifications (account_id, email, token_hash, expires_at) VALUES ($1,$2,$3,$4) RETURNING id::text`,
      [accountId, email, tokenHash, expiresAt.toISOString()],
    );
    return row!.id;
  }

  /** Погасить ссылку и подтвердить адрес — если он всё ещё адрес аккаунта. */
  async consumeVerification(tokenHash: string): Promise<{ account_id: string; email: string } | null> {
    return this.db.withTransaction(async (c) => {
      const r = await c.query<{ account_id: string; email: string }>(
        `UPDATE email_verifications SET used_at=now()
          WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now()
          RETURNING account_id::text, email`,
        [tokenHash],
      );
      const row = r.rows[0];
      if (!row) return null;
      const upd = await c.query(
        `UPDATE accounts SET email_verified_at = COALESCE(email_verified_at, now())
          WHERE id=$1 AND lower(email)=lower($2)`,
        [row.account_id, row.email],
      );
      return upd.rowCount ? row : null;
    });
  }

  async markVerified(accountId: string): Promise<void> {
    await this.db.query(`UPDATE accounts SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id=$1`, [accountId]);
  }

  // ── второй фактор ──

  async enableTotp(accountId: string, secretEnc: string, step: number, codeHashes: string[]): Promise<void> {
    await this.db.withTransaction(async (c) => {
      await c.query(
        `UPDATE accounts SET totp_secret_enc=$2, totp_enabled_at=now(), totp_last_step=$3 WHERE id=$1`,
        [accountId, secretEnc, step],
      );
      await c.query(`DELETE FROM account_recovery_codes WHERE account_id=$1`, [accountId]);
      for (const h of codeHashes) {
        await c.query(`INSERT INTO account_recovery_codes (account_id, code_hash) VALUES ($1,$2)`, [accountId, h]);
      }
    });
  }

  async disableTotp(accountId: string): Promise<void> {
    await this.db.withTransaction(async (c) => {
      await c.query(`UPDATE accounts SET totp_secret_enc=NULL, totp_enabled_at=NULL, totp_last_step=NULL WHERE id=$1`, [accountId]);
      await c.query(`DELETE FROM account_recovery_codes WHERE account_id=$1`, [accountId]);
    });
  }

  /** Запомнить принятый шаг; false — этот или более поздний код уже был принят (повтор). */
  async acceptStep(accountId: string, step: number): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE accounts SET totp_last_step=$2 WHERE id=$1 AND (totp_last_step IS NULL OR totp_last_step < $2)`,
      [accountId, step],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async replaceRecoveryCodes(accountId: string, codeHashes: string[]): Promise<void> {
    await this.db.withTransaction(async (c) => {
      await c.query(`DELETE FROM account_recovery_codes WHERE account_id=$1`, [accountId]);
      for (const h of codeHashes) {
        await c.query(`INSERT INTO account_recovery_codes (account_id, code_hash) VALUES ($1,$2)`, [accountId, h]);
      }
    });
  }

  async useRecoveryCode(accountId: string, codeHash: string): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE account_recovery_codes SET used_at=now() WHERE account_id=$1 AND code_hash=$2 AND used_at IS NULL`,
      [accountId, codeHash],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async recoveryLeft(accountId: string): Promise<number> {
    const row = await this.db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM account_recovery_codes WHERE account_id=$1 AND used_at IS NULL`,
      [accountId],
    );
    return Number(row?.n ?? 0);
  }

  /** Правило организации о втором факторе (Настройки → Безопасность); нет записи — «по желанию». */
  async twoFactorPolicy(tenantId: string): Promise<string> {
    const row = await this.db.one<{ rule: string | null }>(
      `SELECT config->>'twoFactor' AS rule FROM security_policies WHERE tenant_id=$1`, [tenantId],
    );
    return row?.rule ?? 'optional';
  }

  // ── журнал ──

  async audit(i: { tenantId: string; userId: string | null; actorName?: string | null; event: string; ip?: string | null; metadata?: Record<string, unknown> }) {
    await this.db.query(
      `INSERT INTO security_audit (tenant_id, actor_user_id, actor_name, event_type, resource_type, resource_id, target_user_id, ip, metadata)
       VALUES ($1, $2::bigint, $3, $4, 'account', NULL, $2::bigint, $5, $6::jsonb)`,
      [i.tenantId, i.userId, i.actorName ?? null, i.event, i.ip ?? null, JSON.stringify(i.metadata ?? {})],
    ).catch(() => undefined); // журнал не должен ронять вход
  }
}
