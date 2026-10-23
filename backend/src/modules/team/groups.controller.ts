import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { SKILLS } from './skills';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { GroupsRepository } from './groups.repository';

class CreateGroupDto {
  @IsString() @MinLength(1) @MaxLength(96) name!: string;
  @IsOptional() @IsIn(['department', 'group']) kind?: string;
  @IsOptional() @IsString() leadUserId?: string;
  @IsOptional() @IsString() parentId?: string;
}
class UpdateGroupDto {
  @IsOptional() @IsString() @MaxLength(96) name?: string;
  @IsOptional() @IsIn(['department', 'group']) kind?: string;
  @IsOptional() @IsString() leadUserId?: string | null;
  /** #4615: направления отдела (Бэкенд, Контент, Дизайн…) — по ним задача уходит руководителю. */
  @IsOptional() @IsArray() @ArrayMaxSize(16) @IsIn(SKILLS as unknown as string[], { each: true }) directions?: string[];
  /** #4615, 23.10: вышестоящий отдел (вложенность); null — верхний уровень. */
  @IsOptional() @IsString() parentId?: string | null;
}
class MemberDto {
  @IsString() userId!: string;
  /** «deputy» — заместитель / тимлид отдела. */
  @IsOptional() @IsIn(['member', 'deputy']) role?: 'member' | 'deputy';
}
class MemberRoleDto {
  @IsIn(['member', 'deputy']) role!: 'member' | 'deputy';
}

@ApiTags('groups')
@ApiBearerAuth()
@Controller('groups')
@Roles('owner', 'manager', 'member')
export class GroupsController {
  constructor(private readonly repo: GroupsRepository) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.repo.list(user.tenantId);
  }

  @Get(':id/members')
  members(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.repo.listMembers(user.tenantId, id);
  }

  @Post()
  @Roles('owner', 'manager')
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateGroupDto) {
    if (dto.leadUserId && !(await this.repo.userInTenant(user.tenantId, String(dto.leadUserId)))) {
      throw AppException.validation('Руководитель не найден среди сотрудников');
    }
    if (dto.parentId && !(await this.repo.parentAllowed(user.tenantId, null, String(dto.parentId)))) {
      throw AppException.validation('Вышестоящий отдел не найден');
    }
    try {
      return await this.repo.create(user.tenantId, dto.name.trim(), dto.kind ?? 'group', dto.leadUserId ?? null, dto.parentId ? String(dto.parentId) : null);
    } catch (e: any) {
      if (e?.code === '23505') throw AppException.conflict('Группа с таким названием уже есть');
      throw e;
    }
  }

  @Patch(':id')
  @Roles('owner', 'manager')
  async update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateGroupDto) {
    const leadUserId = dto.leadUserId === undefined ? undefined : dto.leadUserId ? String(dto.leadUserId) : null;
    if (leadUserId && !(await this.repo.userInTenant(user.tenantId, leadUserId))) {
      throw AppException.validation('Руководитель не найден среди сотрудников');
    }
    const parentId = dto.parentId === undefined ? undefined : dto.parentId ? String(dto.parentId) : null;
    if (parentId && !(await this.repo.parentAllowed(user.tenantId, id, parentId))) {
      throw AppException.validation('Такой вышестоящий отдел выбрать нельзя: его нет или получится кольцо');
    }
    const row = await this.repo.update(user.tenantId, id, {
      name: dto.name, kind: dto.kind, leadUserId, parentId,
      directions: dto.directions ? [...new Set(dto.directions)] : undefined,
    });
    if (!row) throw AppException.notFound('Group not found');
    return row;
  }

  @Delete(':id')
  @Roles('owner', 'manager')
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.repo.remove(user.tenantId, id);
    return { deleted: true };
  }

  @Post(':id/members')
  @Roles('owner', 'manager')
  async addMember(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: MemberDto) {
    if (!(await this.repo.exists(user.tenantId, id))) throw AppException.notFound('Group not found');
    if (!(await this.repo.userInTenant(user.tenantId, String(dto.userId)))) throw AppException.validation('Сотрудник не найден');
    await this.repo.addMember(user.tenantId, id, dto.userId, dto.role);
    return { ok: true };
  }

  /** Заместитель / тимлид отдела или обычный участник. */
  @Patch(':id/members/:userId')
  @Roles('owner', 'manager')
  async memberRole(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('userId') userId: string, @Body() dto: MemberRoleDto) {
    if (!(await this.repo.exists(user.tenantId, id))) throw AppException.notFound('Group not found');
    if (!(await this.repo.userInTenant(user.tenantId, String(userId)))) throw AppException.validation('Сотрудник не найден');
    await this.repo.addMember(user.tenantId, id, String(userId), dto.role);
    return { ok: true };
  }

  @Delete(':id/members/:userId')
  @Roles('owner', 'manager')
  async removeMember(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('userId') userId: string) {
    void user;
    await this.repo.removeMember(id, userId);
    return { ok: true };
  }
}
