import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface PcAccountRow {
  id: string;
  email: string;
  full_name: string;
  password_hash: string;
  status: 'pending' | 'active' | 'blocked';
  roles: string[];
  requested_role: string | null;
  totp_secret_enc: string | null;
  totp_enabled_at: Date | null;
  totp_last_step: string | null;
  approved_at: Date | null;
  last_login_at: Date | null;
  created_at: Date;
}

export interface PcSessionAuth {
  session_id: string;
  app: string;
  account_id: string;
  email: string;
  full_name: string;
  status: string;
  roles: string[];
}

/** Таблицы консолей (pc_*). Ни одной ссылки на users/chats CRM — изоляция по устройству. */
@Injectable()
export class PcRepository {
  constructor(private readonly db: DbService) {}

  byEmail(email: string) {
    return this.db.one<PcAccountRow>(
      `SELECT id::text, email, full_name, password_hash, status, roles, requested_role, totp_secret_enc,
              totp_enabled_at, totp_last_step::text, approved_at, last_login_at, created_at
         FROM pc_accounts WHERE lower(email)=lower($1)`, [email]);
  }

  byId(id: string) {
    return this.db.one<PcAccountRow>(
      `SELECT id::text, email, full_name, password_hash, status, roles, requested_role, totp_secret_enc,
              totp_enabled_at, totp_last_step::text, approved_at, last_login_at, created_at
         FROM pc_accounts WHERE id=$1`, [id]);
  }

  async create(a: { email: string; name: string; hash: string; role: string; status: string; roles: string[] }) {
    const r = await this.db.one<{ id: string }>(
      `INSERT INTO pc_accounts (email, full_name, password_hash, requested_role, status, roles, approved_at)
       VALUES ($1, $2, $3, $4, $5::text, $6::text[], CASE WHEN $5::text = 'active' THEN now() END)
       ON CONFLICT DO NOTHING RETURNING id::text`,
      [a.email, a.name, a.hash, a.role, a.status, a.roles]);
    return r?.id ?? null;
  }

  /** Чужая заявка на почту владельца не мешает ему: подтвердив пароль CRM, он её перезаписывает. */
  async claimPending(a: { email: string; name: string; hash: string; roles: string[] }) {
    const r = await this.db.one<{ id: string }>(
      `UPDATE pc_accounts SET full_name=$2, password_hash=$3, status='active', roles=$4::text[], approved_at=now(),
              totp_secret_enc=NULL, totp_enabled_at=NULL, totp_last_step=NULL, updated_at=now()
        WHERE lower(email)=lower($1) AND status='pending' RETURNING id::text`, [a.email, a.name, a.hash, a.roles]);
    return r?.id ?? null;
  }

  /** Есть ли уже действующий владелец — первым владельцем становится только владелец компании платформы. */
  async hasActiveOwner(): Promise<boolean> {
    const r = await this.db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM pc_accounts WHERE status='active' AND 'owner' = ANY(roles)`);
    return (r?.n ?? 0) > 0;
  }

  /** Владелец компании-платформы в CRM: его первая регистрация в консоли одобряется сама. */
  platformOwner(email: string) {
    return this.db.one<{ password_hash: string }>(
      `SELECT a.password_hash
         FROM users u JOIN roles r ON r.id=u.role_id JOIN tenants t ON t.id=u.tenant_id
         JOIN accounts a ON a.id=u.account_id
        WHERE t.is_platform AND r.code='owner' AND u.is_active AND lower(a.email)=lower($1)
        LIMIT 1`, [email]);
  }

  setTotp(id: string, secretEnc: string | null) {
    return this.db.query(`UPDATE pc_accounts SET totp_secret_enc=$2, totp_enabled_at=NULL, updated_at=now() WHERE id=$1`, [id, secretEnc]);
  }

  enableTotp(id: string, step: number) {
    return this.db.query(`UPDATE pc_accounts SET totp_enabled_at=now(), totp_last_step=$2, updated_at=now() WHERE id=$1`, [id, step]);
  }

  /** Шаг кода запоминаем атомарно: один и тот же код второй раз не пройдёт. */
  async useStep(id: string, step: number): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE pc_accounts SET totp_last_step=$2 WHERE id=$1 AND (totp_last_step IS NULL OR totp_last_step < $2)`, [id, step]);
    return (r.rowCount ?? 0) > 0;
  }

  touchLogin(id: string) {
    return this.db.query(`UPDATE pc_accounts SET last_login_at=now() WHERE id=$1`, [id]);
  }

  async createSession(s: { accountId: string; app: string; hash: string; ip?: string; ua?: string; days: number }) {
    const r = await this.db.one<{ id: string }>(
      `INSERT INTO pc_sessions (account_id, app, refresh_hash, ip, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + ($6::int * interval '1 day')) RETURNING id::text`,
      [s.accountId, s.app, s.hash, s.ip?.slice(0, 64) ?? null, s.ua?.slice(0, 255) ?? null, s.days]);
    return r!.id;
  }

  /** Поворот refresh: старый хеш меняется на новый одной строкой — повтор старого не пройдёт. */
  async rotate(oldHash: string, newHash: string) {
    return this.db.one<{ id: string; account_id: string; app: string }>(
      `UPDATE pc_sessions SET refresh_hash=$2, last_used_at=now()
        WHERE refresh_hash=$1 AND revoked_at IS NULL AND expires_at > now()
        RETURNING id::text, account_id::text, app`, [oldHash, newHash]);
  }

  revokeByHash(hash: string) {
    return this.db.query(`UPDATE pc_sessions SET revoked_at=now() WHERE refresh_hash=$1 AND revoked_at IS NULL`, [hash]);
  }

  /** Отзыв доступа прекращает действующие сессии (§7). */
  revokeAll(accountId: string, app?: string) {
    return this.db.query(
      `UPDATE pc_sessions SET revoked_at=now() WHERE account_id=$1 AND revoked_at IS NULL AND ($2::text IS NULL OR app=$2)`,
      [accountId, app ?? null]);
  }

  /** Проверка на каждый запрос: сессия жива, человек активен — роли берутся свежие, не из токена. */
  sessionAuth(sessionId: string) {
    return this.db.one<PcSessionAuth>(
      `SELECT s.id::text AS session_id, s.app, a.id::text AS account_id, a.email, a.full_name, a.status, a.roles
         FROM pc_sessions s JOIN pc_accounts a ON a.id=s.account_id
        WHERE s.id=$1 AND s.revoked_at IS NULL AND s.expires_at > now()`, [sessionId]);
  }

  // ── Сотрудники платформы ──
  staff() {
    return this.db.many<{
      id: string; email: string; full_name: string; status: string; roles: string[]; requested_role: string | null;
      mfa: boolean; created_at: Date; approved_at: Date | null; last_login_at: Date | null;
    }>(
      `SELECT id::text, email, full_name, status, roles, requested_role, totp_enabled_at IS NOT NULL AS mfa,
              created_at, approved_at, last_login_at
         FROM pc_accounts ORDER BY (status='pending') DESC, created_at DESC`);
  }

  setStaff(id: string, patch: { status: string; roles: string[] }, by: string) {
    return this.db.query(
      `UPDATE pc_accounts SET status=$2::text, roles=$3::text[], updated_at=now(),
              approved_by = CASE WHEN status='pending' AND $2::text='active' THEN $4::bigint ELSE approved_by END,
              approved_at = CASE WHEN status='pending' AND $2::text='active' THEN now() ELSE approved_at END
        WHERE id=$1`, [id, patch.status, patch.roles, by]);
  }

  async activeOwners(): Promise<number> {
    const r = await this.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM pc_accounts WHERE status='active' AND 'owner'=ANY(roles)`);
    return r?.n ?? 0;
  }

  audit(e: { accountId?: string | null; app?: string | null; action: string; target?: string | null; meta?: Record<string, unknown>; ip?: string | null }) {
    return this.db.query(
      `INSERT INTO pc_audit (account_id, app, action, target, meta, ip) VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [e.accountId ?? null, e.app ?? null, e.action, e.target ?? null, JSON.stringify(e.meta ?? {}), e.ip?.slice(0, 64) ?? null]);
  }

  auditList(limit: number) {
    return this.db.many<{ id: string; at: Date; who: string | null; app: string | null; action: string; target: string | null; meta: Record<string, unknown>; ip: string | null }>(
      `SELECT l.id::text, l.created_at AS at, a.full_name AS who, l.app, l.action, l.target, l.meta, l.ip
         FROM pc_audit l LEFT JOIN pc_accounts a ON a.id=l.account_id
        ORDER BY l.id DESC LIMIT $1`, [limit]);
  }
}
