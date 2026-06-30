import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser, Public, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { InvitesService } from './invites.service';

class CreateInviteDto {
  @IsEmail() email!: string;
  @IsIn(['owner', 'manager', 'member']) role!: string;
  @IsOptional() @IsString() positionId?: string;
}

class AcceptInviteDto {
  @IsString() token!: string;
  @IsString() @MaxLength(160) fullName!: string;
  @IsString() @MinLength(8) @MaxLength(128) password!: string;
}

@ApiTags('invites')
@Controller('invites')
export class InvitesController {
  constructor(private readonly invites: InvitesService) {}

  @ApiBearerAuth()
  @Get()
  @Roles('owner', 'manager')
  listPending(@CurrentUser() user: AuthUser) {
    return this.invites.listPending(user.tenantId);
  }

  @ApiBearerAuth()
  @Post()
  @Roles('owner', 'manager')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateInviteDto) {
    return this.invites.create(user.tenantId, user.userId, dto);
  }

  @Public()
  @Post('accept')
  accept(@Body() dto: AcceptInviteDto) {
    return this.invites.accept(dto);
  }
}
