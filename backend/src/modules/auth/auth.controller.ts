import { Body, Controller, Get, Headers, Ip, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser, Public, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AuthService, SessionMeta } from './auth.service';
import { PasswordResetService } from './password-reset.service';
import { LoginDto, LogoutDto, RefreshDto, RegisterDto } from './auth.dto';

class SwitchOrgDto {
  @IsString() tenantId!: string;
}
class RenameOrgDto {
  @IsString() @MinLength(2) @MaxLength(160) name!: string;
}
class CreateOrgDto {
  @IsString() @MinLength(2) @MaxLength(160) name!: string;
}
class ResetLinkDto {
  @IsString() userId!: string;
}
class ResetPasswordDto {
  @IsString() token!: string;
  @IsString() @MinLength(8) @MaxLength(128) password!: string;
}

@ApiTags('auth')
@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly reset: PasswordResetService,
  ) {}

  // ── сброс пароля (почты в проекте нет: владелец выдаёт ссылку и передаёт лично) ──

  /** Владелец выдаёт сотруднику одноразовую ссылку. Сам пароль владелец не узнаёт. */
  @ApiBearerAuth()
  @Post('auth/password/reset-link')
  @Roles('owner')
  resetLink(@CurrentUser() user: AuthUser, @Body() dto: ResetLinkDto) {
    return this.reset.createLink(user.tenantId, user.userId, dto.userId);
  }

  @Public()
  @Get('auth/password/reset/:token')
  resetInfo(@Param('token') token: string) {
    return this.reset.info(token);
  }

  @Public()
  @Post('auth/password/reset')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.reset.complete(dto.token, dto.password);
  }

  @Public()
  @Post('auth/register')
  register(@Body() dto: RegisterDto, @Headers('user-agent') ua: string, @Ip() ip: string) {
    return this.auth.register(dto, this.meta(ua, ip));
  }

  @Public()
  @Post('auth/login')
  login(@Body() dto: LoginDto, @Headers('user-agent') ua: string, @Ip() ip: string) {
    return this.auth.login(dto, this.meta(ua, ip));
  }

  @Public()
  @Post('auth/refresh')
  refresh(@Body() dto: RefreshDto, @Headers('user-agent') ua: string, @Ip() ip: string) {
    return this.auth.refresh(dto.refreshToken, this.meta(ua, ip));
  }

  private meta(ua?: string, ip?: string): SessionMeta {
    return { userAgent: ua?.slice(0, 250), ip };
  }

  @Public()
  @Post('auth/logout')
  async logout(@Body() dto: LogoutDto) {
    await this.auth.logout(dto.refreshToken);
    return { loggedOut: true };
  }

  @ApiBearerAuth()
  @Get('auth/organizations')
  organizations(@CurrentUser() user: AuthUser) {
    return this.auth.organizations(user.tenantId, user.userId);
  }

  @ApiBearerAuth()
  @Post('auth/switch-org')
  switchOrg(@CurrentUser() user: AuthUser, @Body() dto: SwitchOrgDto, @Headers('user-agent') ua: string, @Ip() ip: string) {
    return this.auth.switchOrg(user.tenantId, user.userId, dto.tenantId, this.meta(ua, ip));
  }

  /** Переименовать текущее пространство — только его создателю (владельцу). */
  @ApiBearerAuth()
  @Patch('auth/organizations/current')
  renameOrg(@CurrentUser() user: AuthUser, @Body() dto: RenameOrgDto) {
    return this.auth.renameOrg(user.tenantId, user.role, dto.name);
  }

  @ApiBearerAuth()
  @Post('auth/organizations')
  createOrg(@CurrentUser() user: AuthUser, @Body() dto: CreateOrgDto, @Headers('user-agent') ua: string, @Ip() ip: string) {
    return this.auth.createOrg(user.tenantId, user.userId, dto.name, this.meta(ua, ip));
  }
}
