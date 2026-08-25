import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AppException } from '../../common/http/app-exception';
import { RoleCode } from '../../common/auth/jwt.types';
import { PositionsRepository } from '../team/positions.repository';
import { GroupsRepository } from '../team/groups.repository';
import { AccountsRepository } from '../auth/accounts.repository';
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

/**
 * Итог создания сотрудника. `usedExistingAccount` — у человека уже был глобальный аккаунт
 * (он состоит в другой организации), поэтому заданный сейчас пароль НЕ применён:
 * вход идёт по паролю аккаунта. Вызывающий обязан сказать об этом человеку.
 */
export interface CreateUserResult {
  user: PublicUser;
  usedExistingAccount: boolean;
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
    private readonly accounts: AccountsRepository,
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
  ): Promise<CreateUserResult> {
    const role = input.role ?? 'member';
    if (!isAssignableTeamRole(role)) throw AppException.validation('Роль client не назначается через команду');
    const exists = await this.repo.findByEmail(tenantId, input.email);
    if (exists) throw AppException.conflict('Пользователь с таким e-mail уже есть в организации');
    if (input.positionId && !(await this.positions.exists(tenantId, input.positionId))) {
      throw AppException.validation('Должность не найдена');
    }
    // Глобальный аккаунт: используем существующий (человек уже зарегистрирован) либо создаём.
    // ВАЖНО: пароль существующего аккаунта НЕ трогаем. Перезаписать его здесь означало бы,
    // что любой обладатель ссылки-приглашения может указать чужой e-mail и сменить чужой пароль.
    // Поэтому такой человек входит своим прежним паролем, а строка users получает хеш аккаунта.
    const existingAccount = await this.accounts.findByEmail(input.email);
    const account = existingAccount
      ?? (await this.accounts.create(input.email, await argon2.hash(input.password), input.fullName));
    const row = await this.repo.create({
      tenantId,
      email: input.email,
      passwordHash: account.password_hash,
      fullName: input.fullName,
      roleCode: role,
      accountId: account.id,
    });
    if (input.positionId) await this.repo.updateManaged(tenantId, row.id, { positionId: input.positionId });
    if (input.groupIds?.length) await this.groups.setUserGroups(tenantId, row.id, input.groupIds);
    return { user: toPublicUser(row), usedExistingAccount: !!existingAccount };
  }

  /** Создание client-пользователя портала (роль client + привязка к заказчику). Отдельно от команды. */
  async createClientUser(
    tenantId: string,
    input: { email: string; password: string; fullName: string; clientId: string },
  ): Promise<CreateUserResult> {
    const exists = await this.repo.findByEmail(tenantId, input.email);
    if (exists) throw AppException.conflict('Пользователь с таким e-mail уже есть в организации');
    // пароль существующего аккаунта не трогаем — см. комментарий в createUser
    const existingAccount = await this.accounts.findByEmail(input.email);
    const account = existingAccount
      ?? (await this.accounts.create(input.email, await argon2.hash(input.password), input.fullName));
    const row = await this.repo.create({
      tenantId, email: input.email, passwordHash: account.password_hash, fullName: input.fullName,
      roleCode: 'client', accountId: account.id, clientId: input.clientId,
    });
    return { user: toPublicUser(row), usedExistingAccount: !!existingAccount };
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
    const byUser = await this.groups.groupsForUsers(tenantId); // одним запросом на всех, а не по запросу на человека
    return rows.map((u) => ({
      id: u.id,
      email: u.email,
      fullName: u.full_name,
      role: u.role_code,
      isActive: u.is_active,
      positionId: u.position_id,
      positionName: u.position_name,
      // человека узнают по лицу: где показываем имя — показываем и аватар
      avatarUrl: u.avatar_file_id ? `/api/files/${u.avatar_file_id}` : null,
      groups: byUser.get(String(u.id)) ?? [],
    }));
  }
}
