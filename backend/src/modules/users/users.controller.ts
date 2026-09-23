import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { SKILLS } from '../team/skills';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser, RoleCode } from '../../common/auth/jwt.types';
import { UsersService } from './users.service';
import { Role } from './team-invariants';

class CreateUserDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(8) @MaxLength(128) password!: string;
  @IsString() @MaxLength(160) fullName!: string;
  @IsOptional() @IsIn(['owner', 'manager', 'member']) role?: RoleCode;
  @IsOptional() @IsString() positionId?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) groupIds?: string[];
}

class UpdateUserDto {
  @IsOptional() @IsIn(['owner', 'manager', 'member']) role?: Role;
  @IsOptional() @IsString() positionId?: string | null;
  @IsOptional() @IsArray() @IsString({ each: true }) groupIds?: string[];
  @IsOptional() @IsBoolean() isActive?: boolean;
  /** Чем занимается: направления из справочника (ТЗ-10, этап 3). */
  @IsOptional() @IsArray() @IsIn(SKILLS as unknown as string[], { each: true }) skills?: string[];
  @IsOptional() @IsBoolean() canReceiveAutoTasks?: boolean;
  @IsOptional() @IsNumber() @Min(0.5) @Max(2) autoAssignmentWeight?: number;
}

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
@Roles('owner', 'manager', 'member')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.users.list(user.tenantId);
  }

  @Post()
  @Roles('owner', 'manager')
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateUserDto) {
    const created = await this.users.createUser(user.tenantId, dto);
    // форма ответа прежняя (сотрудник), плюс честный флаг: если аккаунт уже существовал,
    // заданный пароль не применён — человек входит своим прежним
    return { ...created.user, usedExistingAccount: created.usedExistingAccount };
  }

  @Patch(':id')
  @Roles('owner', 'manager')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.users.updateUser(user.tenantId, id, {
      roleCode: dto.role,
      positionId: dto.positionId,
      groupIds: dto.groupIds,
      isActive: dto.isActive,
      skills: dto.skills,
      canReceiveAutoTasks: dto.canReceiveAutoTasks,
      autoAssignmentWeight: dto.autoAssignmentWeight,
    }, { actorId: user.userId, actorRole: user.role });
  }
}
