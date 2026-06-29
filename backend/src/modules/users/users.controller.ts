import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser, RoleCode } from '../../common/auth/jwt.types';
import { UsersService } from './users.service';

class CreateUserDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(8) @MaxLength(128) password!: string;
  @IsString() @MaxLength(160) fullName!: string;
  @IsOptional() @IsIn(['owner', 'manager', 'member', 'client']) role?: RoleCode;
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
}
