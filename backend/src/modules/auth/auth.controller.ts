import { Body, Controller, Get, Headers, HttpCode, Ip, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser, Public, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AuthService, SessionMeta } from './auth.service';
import { PasswordResetService } from './password-reset.service';
import {
  ForgotPasswordDto, LoginDto, LogoutDto, MfaCodeDto, MfaDisableDto, MfaLoginDto, MfaPasswordDto,
  RefreshDto, RegisterDto, TokenDto,
} from './auth.dto';
import { AccountSecurityService } from './account-security.service';
import { UsersRepository } from '../users/users.repository';
import { SocialService } from './social.service';
import { QaSwitchService } from './qa-switch.service';
import { AppException } from '../../common/http/app-exception';

class QaSwitchDto {
  @IsOptional() @IsString() @MaxLength(20) targetUserId?: string;
}

/** #1562: из сессии тестового сотрудника нельзя менять ему вход, пароль и пространства. */
function notActing(user: AuthUser) {
  if (user.actorId) throw AppException.forbidden('Недоступно, пока вы вошли как тестовый сотрудник');
}

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
  @IsString() @MaxLength(128) password!: string;
}

class GoogleLoginDto {
  @IsString() @MaxLength(4096) idToken!: string;
  /** Название организации приходит вторым заходом — когда человек пришёл впервые. */
  @IsOptional() @IsString() @MaxLength(160) tenantName?: string;
  /** #4675: галочка Политики конфиденциальности — нужна, когда заводится новый аккаунт. */
  @IsOptional() @IsBoolean() acceptPrivacy?: boolean;
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
    private readonly qa: QaSwitchService,
    private readonly security: AccountSecurityService,
    private readonly users: UsersRepository,
  ) {}

  // ── #1562: временный вход как тестовый сотрудник (только по строке в qa_switch_access) ──

  @ApiBearerAuth()
  @Get('auth/qa-switch')
  qaStatus(@CurrentUser() user: AuthUser) {
    return this.qa.status(user);
  }

  @ApiBearerAuth()
  @Post('auth/qa-switch')
  qaSwitch(@CurrentUser() user: AuthUser, @Body() dto: QaSwitchDto, @Headers('user-agent') ua: string, @Ip() ip: string) {
    return this.qa.switchTo(user, dto.targetUserId, this.meta(ua, ip));
  }

  @ApiBearerAuth()
  @Post('auth/qa-switch/back')
  qaBack(@CurrentUser() user: AuthUser, @Headers('user-agent') ua: string, @Ip() ip: string) {
    return this.qa.back(user, this.meta(ua, ip));
  }

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
    return this.social.google(dto.idToken, dto.tenantName, this.meta(ua, ip), dto.acceptPrivacy);
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
    notActing(user);
    return this.social.linkGoogle(user.tenantId, user.userId, dto.idToken);
  }

  @ApiBearerAuth()
  @Post('auth/telegram/link')
  linkTelegram(@CurrentUser() user: AuthUser, @Body() dto: TelegramLoginDto) {
    notActing(user);
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
  resetInfo(@Param('token') token: string, @Ip() ip: string) {
    return this.reset.info(token, { ip });
  }

  @Public()
  @Post('auth/password/reset')
  resetPassword(@Body() dto: ResetPasswordDto, @Headers('user-agent') ua: string, @Ip() ip: string) {
    return this.reset.complete(dto.token, dto.password, this.meta(ua, ip));
  }

  /** «Забыли пароль?» — письмо со ссылкой. Ответ одинаковый, есть такой аккаунт или нет. */
  @Public()
  @Post('auth/password/forgot')
  @HttpCode(200)
  forgot(@Body() dto: ForgotPasswordDto, @Headers('user-agent') ua: string, @Ip() ip: string) {
    return this.reset.requestByEmail(dto.email, this.meta(ua, ip));
  }

  // ── подтверждение почты ──

  @Public()
  @Post('auth/email/verify')
  @HttpCode(200)
  verifyEmail(@Body() dto: TokenDto, @Headers('user-agent') ua: string, @Ip() ip: string) {
    return this.security.verifyEmail(dto.token, this.meta(ua, ip));
  }

  @ApiBearerAuth()
  @Post('auth/email/resend')
  @HttpCode(200)
  async resendVerification(@CurrentUser() user: AuthUser) {
    return this.security.resendVerification(await this.accountOf(user));
  }

  // ── двухфакторный вход (код из приложения) ──

  @Public()
  @Post('auth/login/mfa')
  @HttpCode(200)
  loginMfa(@Body() dto: MfaLoginDto, @Headers('user-agent') ua: string, @Ip() ip: string) {
    return this.auth.loginMfa(dto.mfaToken, dto.code, this.meta(ua, ip));
  }

  @ApiBearerAuth()
  @Get('auth/mfa')
  async mfaStatus(@CurrentUser() user: AuthUser) {
    return this.security.mfaStatus(await this.accountOf(user));
  }

  @ApiBearerAuth()
  @Post('auth/mfa/setup')
  @HttpCode(200)
  async mfaSetup(@CurrentUser() user: AuthUser, @Body() dto: MfaPasswordDto) {
    notActing(user);
    return this.security.setup(await this.accountOf(user), dto.password);
  }

  @ApiBearerAuth()
  @Post('auth/mfa/enable')
  @HttpCode(200)
  async mfaEnable(@CurrentUser() user: AuthUser, @Body() dto: MfaCodeDto, @Headers('user-agent') ua: string, @Ip() ip: string) {
    notActing(user);
    return this.security.enable(await this.accountOf(user), dto.code, this.meta(ua, ip));
  }

  @ApiBearerAuth()
  @Post('auth/mfa/disable')
  @HttpCode(200)
  async mfaDisable(@CurrentUser() user: AuthUser, @Body() dto: MfaDisableDto, @Headers('user-agent') ua: string, @Ip() ip: string) {
    notActing(user);
    return this.security.disable(await this.accountOf(user), dto.password, dto.code, this.meta(ua, ip));
  }

  @ApiBearerAuth()
  @Post('auth/mfa/recovery-codes')
  @HttpCode(200)
  async mfaRecovery(@CurrentUser() user: AuthUser, @Body() dto: MfaCodeDto, @Headers('user-agent') ua: string, @Ip() ip: string) {
    notActing(user);
    return this.security.regenerateRecovery(await this.accountOf(user), dto.code, this.meta(ua, ip));
  }

  private async accountOf(user: AuthUser): Promise<string> {
    const acc = await this.users.accountIdOf(user.tenantId, user.userId);
    if (!acc?.account_id) throw AppException.forbidden('Нет аккаунта');
    return String(acc.account_id);
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
    notActing(user);
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
    notActing(user);
    return this.auth.createOrg(user.tenantId, user.userId, dto.name, this.meta(ua, ip));
  }
}
