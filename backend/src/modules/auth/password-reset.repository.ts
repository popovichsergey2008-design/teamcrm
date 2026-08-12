import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface ResetRow {
  id: string;
  account_id: string;
  email: string;
  full_name: string;
}

@Injectable()
export class PasswordResetRepository {
  constructor(private readonly db: DbService) {}

  /** Сотрудник организации + его глобальный аккаунт (пароль живёт на аккаунте). */
  teamUserAccount(tenantId: string, userId: string) {
    return this.db.one<{ account_id: string | null; email: string; full_name: string }>(
      `SELECT account_id, email, full_name FROM users WHERE tenant_id=$1 AND id=$2`,
      [tenantId, userId],
    );
  }

  /** Другие организации того же аккаунта — сброс сменит пароль и в них, это надо показать. */
  async otherTenants(accountId: string, exceptTenantId: string): Promise<string[]> {
    const rows = await this.db.many<{ name: string }>(
      `SELECT DISTINCT t.name FROM users u JOIN tenants t ON t.id=u.tenant_id
        WHERE u.account_id=$1 AND u.tenant_id <> $2`,
      [accountId, exceptTenantId],
    );
    return rows.map((r) => r.name);
  }

  /** Выдача новой ссылки гасит прежние неиспользованные — действует всегда только последняя. */
  async invalidateActive(accountId: string): Promise<void> {
    await this.db.query(
      `UPDATE password_resets SET used_at=now() WHERE account_id=$1 AND used_at IS NULL`,
      [accountId],
    );
  }

  async create(i: { accountId: string; tenantId: string | null; createdBy: string | null; tokenHash: string; expiresAt: Date }): Promise<void> {
    await this.db.query(
      `INSERT INTO password_resets (account_id, tenant_id, created_by, token_hash, expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [i.accountId, i.tenantId, i.createdBy, i.tokenHash, i.expiresAt.toISOString()],
    );
  }

  /** Действующий токен: не использован и не истёк. */
  findValid(tokenHash: string): Promise<ResetRow | null> {
    return this.db.one<ResetRow>(
      `SELECT r.id, r.account_id, a.email, a.full_name
         FROM password_resets r JOIN accounts a ON a.id=r.account_id
        WHERE r.token_hash=$1 AND r.used_at IS NULL AND r.expires_at > now()`,
      [tokenHash],
    );
  }

  async markUsed(id: string): Promise<void> {
    await this.db.query(`UPDATE password_resets SET used_at=now() WHERE id=$1`, [id]);
  }

  /** После смены пароля разлогиниваем аккаунт везде — во всех его организациях. */
  async revokeAccountSessions(accountId: string): Promise<number> {
    const res = await this.db.query(
      `UPDATE refresh_tokens SET revoked_at=now()
        WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE account_id=$1)`,
      [accountId],
    );
    return res.rowCount ?? 0;
  }
}
