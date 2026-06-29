import { Injectable } from '@nestjs/common';
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
}
