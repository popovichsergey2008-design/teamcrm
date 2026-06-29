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
