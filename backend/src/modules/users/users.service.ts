import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AppException } from '../../common/http/app-exception';
import { RoleCode } from '../../common/auth/jwt.types';
import { UserRow, UsersRepository } from './users.repository';

/** Публичное (безопасное) представление пользователя — без password_hash. */
export interface PublicUser {
  id: string;
  tenantId: string;
  email: string;
  fullName: string;
  role: string;
  isActive: boolean;
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    fullName: row.full_name,
    role: row.role_code,
    isActive: row.is_active,
  };
}

@Injectable()
export class UsersService {
  constructor(private readonly repo: UsersRepository) {}

  findById(tenantId: string, id: string) {
    return this.repo.findById(tenantId, id);
  }

  /** Создание пользователя в рамках tenant (owner/manager приглашает сотрудника). */
  async createUser(
    tenantId: string,
    input: { email: string; password: string; fullName: string; role?: RoleCode },
  ): Promise<PublicUser> {
    const exists = await this.repo.findByEmail(tenantId, input.email);
    if (exists) throw AppException.conflict('Email already exists in tenant');
    const passwordHash = await argon2.hash(input.password);
    const row = await this.repo.create({
      tenantId,
      email: input.email,
      passwordHash,
      fullName: input.fullName,
      roleCode: input.role ?? 'member',
    });
    return toPublicUser(row);
  }

  async list(tenantId: string): Promise<PublicUser[]> {
    const rows = await this.repo.listByTenant(tenantId);
    return rows.map(toPublicUser);
  }
}
