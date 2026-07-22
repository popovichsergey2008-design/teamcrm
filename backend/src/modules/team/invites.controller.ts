import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
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

class CreateInviteLinkDto {
  @IsOptional() @IsIn(['member', 'manager']) role?: string;
  @IsOptional() @IsString() positionId?: string;
  @IsOptional() @IsInt() @Min(1) @Max(1000) maxUses?: number;
  @IsOptional() @IsInt() @Min(1) @Max(365) expiresInDays?: number;
}

class AcceptInviteLinkDto {
  @IsString() token!: string;
  @IsEmail() email!: string;
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

  // ── многоразовые ссылки-приглашения ──
  @ApiBearerAuth()
  @Get('links')
  @Roles('owner', 'manager')
  listLinks(@CurrentUser() user: AuthUser) {
    return this.invites.listLinks(user.tenantId);
  }

  @ApiBearerAuth()
  @Post('links')
  @Roles('owner', 'manager')
  createLink(@CurrentUser() user: AuthUser, @Body() dto: CreateInviteLinkDto) {
    return this.invites.createLink(user.tenantId, user.userId, dto);
  }

  @ApiBearerAuth()
  @Delete('links/:id')
  @Roles('owner', 'manager')
  deactivateLink(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.invites.deactivateLink(user.tenantId, id);
  }

  @Public()
  @Get('links/:token/info')
  linkInfo(@Param('token') token: string) {
    return this.invites.linkInfo(token);
  }

  @Public()
  @Post('links/accept')
  acceptLink(@Body() dto: AcceptInviteLinkDto) {
    return this.invites.acceptLink(dto);
  }
}
