import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
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
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateUserDto) {
    return this.users.createUser(user.tenantId, dto);
  }

  @Patch(':id')
  @Roles('owner', 'manager')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.users.updateUser(user.tenantId, id, {
      roleCode: dto.role,
      positionId: dto.positionId,
      groupIds: dto.groupIds,
      isActive: dto.isActive,
    });
  }
}
