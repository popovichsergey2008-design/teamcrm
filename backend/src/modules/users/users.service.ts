import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AppException } from '../../common/http/app-exception';
import { RoleCode } from '../../common/auth/jwt.types';
import { PositionsRepository } from '../team/positions.repository';
import { GroupsRepository } from '../team/groups.repository';
import { UserRow, UsersRepository } from './users.repository';
import { isAssignableTeamRole, removesLastActiveOwner, Role } from './team-invariants';

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
  constructor(
    private readonly repo: UsersRepository,
    private readonly positions: PositionsRepository,
    private readonly groups: GroupsRepository,
  ) {}

  findById(tenantId: string, id: string) {
    return this.repo.findById(tenantId, id);
  }

  /** Создание сотрудника (owner/manager). Роль client через команду не назначается. */
  async createUser(
    tenantId: string,
    input: {
      email: string;
      password: string;
      fullName: string;
      role?: RoleCode;
      positionId?: string | null;
      groupIds?: string[];
    },
  ): Promise<PublicUser> {
    const role = input.role ?? 'member';
    if (!isAssignableTeamRole(role)) throw AppException.validation('Роль client не назначается через команду');
    const exists = await this.repo.findByEmail(tenantId, input.email);
    if (exists) throw AppException.conflict('Email already exists in tenant');
    if (input.positionId && !(await this.positions.exists(tenantId, input.positionId))) {
      throw AppException.validation('Должность не найдена');
    }
    const passwordHash = await argon2.hash(input.password);
    const row = await this.repo.create({
      tenantId,
      email: input.email,
      passwordHash,
      fullName: input.fullName,
      roleCode: role,
    });
    if (input.positionId) await this.repo.updateManaged(tenantId, row.id, { positionId: input.positionId });
    if (input.groupIds?.length) await this.groups.setUserGroups(tenantId, row.id, input.groupIds);
    return toPublicUser(row);
  }

  /** Управление участником: роль/должность/группы/активность (owner/manager). */
  async updateUser(
    tenantId: string,
    id: string,
    patch: { roleCode?: Role; positionId?: string | null; groupIds?: string[]; isActive?: boolean },
  ): Promise<PublicUser> {
    const target = await this.repo.findById(tenantId, id);
    if (!target) throw AppException.notFound('User not found');

    if (patch.roleCode !== undefined && !isAssignableTeamRole(patch.roleCode)) {
      throw AppException.validation('Недопустимая роль');
    }
    // инвариант последнего owner
    const activeOwners = await this.repo.countActiveOwners(tenantId);
    if (
      removesLastActiveOwner({
        targetIsActiveOwner: target.role_code === 'owner' && target.is_active,
        newRole: patch.roleCode,
        newActive: patch.isActive,
        activeOwnerCount: activeOwners,
      })
    ) {
      throw AppException.conflict('Нельзя понизить/деактивировать последнего owner');
    }
    if (patch.positionId && !(await this.positions.exists(tenantId, patch.positionId))) {
      throw AppException.validation('Должность не найдена');
    }

    const updated = await this.repo.updateManaged(tenantId, id, {
      roleCode: patch.roleCode,
      positionId: patch.positionId,
      isActive: patch.isActive,
    });
    if (patch.groupIds !== undefined) await this.groups.setUserGroups(tenantId, id, patch.groupIds);
    return toPublicUser(updated as UserRow);
  }

  /** Список команды с должностью и группами. */
  async list(tenantId: string) {
    const rows = await this.repo.listEnriched(tenantId);
    const out: any[] = [];
    for (const u of rows) {
      const groups = await this.groups.groupsForUser(tenantId, u.id);
      out.push({
        id: u.id,
        email: u.email,
        fullName: u.full_name,
        role: u.role_code,
        isActive: u.is_active,
        positionId: u.position_id,
        positionName: u.position_name,
        groups,
      });
    }
    return out;
  }
}
