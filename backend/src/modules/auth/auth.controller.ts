import { Body, Controller, Get, Headers, Ip, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser, Public, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AuthService, SessionMeta } from './auth.service';
import { PasswordResetService } from './password-reset.service';
import { LoginDto, LogoutDto, RefreshDto, RegisterDto } from './auth.dto';
import { SocialService } from './social.service';

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

class GoogleLoginDto {
  @IsString() @MaxLength(4096) idToken!: string;
  /** Название организации приходит вторым заходом — когда человек пришёл впервые. */
  @IsOptional() @IsString() @MaxLength(160) tenantName?: string;
}
class TelegramLoginDto {
  /** Виджет Telegram отдаёт произвольный набор полей: их состав задаёт он, не мы. */
  @IsObject() data!: Record<string, string>;
}

@ApiTags('auth')
@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly reset: PasswordResetService,
    private readonly social: SocialService,
  ) {}

  // ── вход через Google и Telegram ──

  /**
   * Какие входы включены на этом сервере.
   *
   * Экран входа спрашивает это первым делом и рисует только то, что работает: ключей
   * может не быть вовсе, и тогда кнопки не появятся.
   */
  @Public()
  @Get('auth/providers')
  providers() {
    return this.social.providers();
  }

  @Public()
  @Post('auth/google')
  google(@Body() dto: GoogleLoginDto, @Headers('user-agent') ua: string, @Ip() ip: string) {
    return this.social.google(dto.idToken, dto.tenantName, this.meta(ua, ip));
  }

  @Public()
  @Post('auth/telegram')
  telegram(@Body() dto: TelegramLoginDto, @Headers('user-agent') ua: string, @Ip() ip: string) {
    return this.social.telegram(dto.data, this.meta(ua, ip));
  }

  /** Привязать вход к своему аккаунту, уже будучи внутри. */
  @ApiBearerAuth()
  @Post('auth/google/link')
  linkGoogle(@CurrentUser() user: AuthUser, @Body() dto: GoogleLoginDto) {
    return this.social.linkGoogle(user.tenantId, user.userId, dto.idToken);
  }

  @ApiBearerAuth()
  @Post('auth/telegram/link')
  linkTelegram(@CurrentUser() user: AuthUser, @Body() dto: TelegramLoginDto) {
    return this.social.linkTelegram(user.tenantId, user.userId, dto.data);
  }

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
