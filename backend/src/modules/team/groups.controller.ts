import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { GroupsRepository } from './groups.repository';

class CreateGroupDto {
  @IsString() @MinLength(1) @MaxLength(96) name!: string;
  @IsOptional() @IsIn(['department', 'group']) kind?: string;
  @IsOptional() @IsString() leadUserId?: string;
}
class UpdateGroupDto {
  @IsOptional() @IsString() @MaxLength(96) name?: string;
  @IsOptional() @IsIn(['department', 'group']) kind?: string;
  @IsOptional() @IsString() leadUserId?: string | null;
}
class MemberDto {
  @IsString() userId!: string;
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
    try {
      return await this.repo.create(user.tenantId, dto.name.trim(), dto.kind ?? 'group', dto.leadUserId ?? null);
    } catch (e: any) {
      if (e?.code === '23505') throw AppException.conflict('Группа с таким названием уже есть');
      throw e;
    }
  }

  @Patch(':id')
  @Roles('owner', 'manager')
  async update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateGroupDto) {
    const row = await this.repo.update(user.tenantId, id, dto);
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
    await this.repo.addMember(user.tenantId, id, dto.userId);
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
