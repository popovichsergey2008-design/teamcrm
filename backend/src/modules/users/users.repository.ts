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
