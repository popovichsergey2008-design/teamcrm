import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { RoleCode } from '../../common/auth/jwt.types';

export interface UserRow {
  id: string;
  tenant_id: string;
  email: string;
  password_hash: string;
  full_name: string;
  role_id: string;
  role_code: RoleCode;
  is_active: boolean;
  created_at: Date;
}

@Injectable()
export class UsersRepository {
  constructor(private readonly db: DbService) {}

  async findByEmail(tenantId: string, email: string): Promise<UserRow | null> {
    return this.db.one<UserRow>(
      `SELECT u.*, r.code AS role_code
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.tenant_id = $1 AND u.email = $2`,
      [tenantId, email],
    );
  }

  /** Поиск по e-mail без tenant — для логина (e-mail уникален в рамках tenant,
   *  поэтому при коллизии между tenant'ами требуется tenant hint; здесь — глобально
   *  первый активный; для Этапа 1 пары tenant+email достаточно). */
  async findByEmailGlobal(email: string): Promise<UserRow | null> {
    return this.db.one<UserRow>(
      `SELECT u.*, r.code AS role_code
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.email = $1 AND u.is_active = TRUE
        ORDER BY u.created_at ASC
        LIMIT 1`,
      [email],
    );
  }

  async findById(tenantId: string, id: string): Promise<UserRow | null> {
    return this.db.one<UserRow>(
      `SELECT u.*, r.code AS role_code
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.tenant_id = $1 AND u.id = $2`,
      [tenantId, id],
    );
  }

  listByTenant(tenantId: string): Promise<UserRow[]> {
    return this.db.many<UserRow>(
      `SELECT u.*, r.code AS role_code
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.tenant_id = $1 ORDER BY u.created_at ASC`,
      [tenantId],
    );
  }

  /** Список с должностью (имя) — для экрана команды. */
  listEnriched(tenantId: string) {
    return this.db.many(
      `SELECT u.id, u.email, u.full_name, u.is_active, u.position_id,
              r.code AS role_code, p.name AS position_name
         FROM users u
         JOIN roles r ON r.id = u.role_id
         LEFT JOIN positions p ON p.id = u.position_id
        WHERE u.tenant_id = $1 ORDER BY u.created_at ASC`,
      [tenantId],
    );
  }

  /** Полный профиль для личного кабинета. */
  getProfile(tenantId: string, id: string) {
    return this.db.one(
      `SELECT u.id, u.email, u.full_name, u.phone, u.timezone, u.locale,
              u.notify_prefs, u.avatar_file_id, u.weekly_capacity_hours, u.is_active,
              r.code AS role_code, p.name AS position_name, u.position_id
         FROM users u
         JOIN roles r ON r.id = u.role_id
         LEFT JOIN positions p ON p.id = u.position_id
        WHERE u.tenant_id=$1 AND u.id=$2`,
      [tenantId, id],
    );
  }

  updateProfile(
    tenantId: string,
    id: string,
    patch: { full_name?: string; phone?: string | null; timezone?: string; locale?: string },
  ) {
    const sets: string[] = [];
    const vals: any[] = [];
    let i = 1;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${k} = $${i++}`);
      vals.push(v);
    }
    if (!sets.length) return this.getProfile(tenantId, id);
    sets.push('updated_at = now()');
    vals.push(tenantId, id);
    return this.db.query(`UPDATE users SET ${sets.join(', ')} WHERE tenant_id=$${i++} AND id=$${i}`, vals)
      .then(() => this.getProfile(tenantId, id));
  }

  async getPasswordHash(tenantId: string, id: string): Promise<string | null> {
    const r = await this.db.one<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE tenant_id=$1 AND id=$2`,
      [tenantId, id],
    );
    return r?.password_hash ?? null;
  }

  async updatePassword(tenantId: string, id: string, hash: string): Promise<void> {
    await this.db.query(`UPDATE users SET password_hash=$3, updated_at=now() WHERE tenant_id=$1 AND id=$2`, [tenantId, id, hash]);
  }

  async setAvatar(tenantId: string, id: string, fileId: string): Promise<void> {
    await this.db.query(`UPDATE users SET avatar_file_id=$3, updated_at=now() WHERE tenant_id=$1 AND id=$2`, [tenantId, id, fileId]);
  }

  async setNotifyPrefs(tenantId: string, id: string, prefs: unknown): Promise<void> {
    await this.db.query(`UPDATE users SET notify_prefs=$3::jsonb WHERE tenant_id=$1 AND id=$2`, [tenantId, id, JSON.stringify(prefs)]);
  }

  async countActiveOwners(tenantId: string): Promise<number> {
    const r = await this.db.one<{ n: string }>(
      `SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id=u.role_id
        WHERE u.tenant_id=$1 AND r.code='owner' AND u.is_active=TRUE`,
      [tenantId],
    );
    return Number(r?.n ?? 0);
  }

  /** Обновление управляемых полей: роль (по коду), должность, активность. */
  async updateManaged(
    tenantId: string,
    id: string,
    patch: { roleCode?: string; positionId?: string | null; isActive?: boolean },
  ): Promise<UserRow | null> {
    const sets: string[] = [];
    const vals: any[] = [];
    let i = 1;
    if (patch.roleCode !== undefined) {
      sets.push(`role_id = (SELECT id FROM roles WHERE code = $${i++})`);
      vals.push(patch.roleCode);
    }
    if (patch.positionId !== undefined) {
      sets.push(`position_id = $${i++}`);
      vals.push(patch.positionId);
    }
    if (patch.isActive !== undefined) {
      sets.push(`is_active = $${i++}`);
      vals.push(patch.isActive);
    }
    if (!sets.length) return this.findById(tenantId, id);
    sets.push(`updated_at = now()`);
    vals.push(tenantId, id);
    return this.db.one<UserRow>(
      `UPDATE users SET ${sets.join(', ')} WHERE tenant_id = $${i++} AND id = $${i}
       RETURNING *, (SELECT code FROM roles WHERE id = role_id) AS role_code`,
      vals,
    );
  }

  async create(input: {
    tenantId: string;
    email: string;
    passwordHash: string;
    fullName: string;
    roleCode: RoleCode;
  }): Promise<UserRow> {
    const row = await this.db.one<UserRow>(
      `INSERT INTO users (tenant_id, email, password_hash, full_name, role_id)
       SELECT $1, $2, $3, $4, r.id FROM roles r WHERE r.code = $5
       RETURNING *, (SELECT code FROM roles WHERE id = role_id) AS role_code`,
      [input.tenantId, input.email, input.passwordHash, input.fullName, input.roleCode],
    );
    return row as UserRow;
  }
}
