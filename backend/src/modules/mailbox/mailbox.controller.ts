import { Body, Controller, Delete, Get, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import type { Response } from 'express';
import { CurrentUser, Public } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { OAUTH_MAIL_PROVIDERS, RESUME_MAX } from './mail-oauth';
import { MailOAuthService } from './mail-oauth.service';
import { MailboxService } from './mailbox.service';

class ConnectDto {
  @IsIn(['gmail', 'yandex', 'mailru', 'outlook', 'custom']) provider!: string;
  @IsString() @MaxLength(255) email!: string;
  @IsString() @MaxLength(200) password!: string;
  @IsOptional() @IsString() @MaxLength(255) username?: string;
  @IsOptional() @IsString() @MaxLength(255) imapHost?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(65535) imapPort?: number;
  @IsOptional() @IsString() @MaxLength(255) smtpHost?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(65535) smtpPort?: number;
}

/** Вход кнопкой (#4893): почтовик, исходная просьба боту и куда вернуть человека. */
class OAuthStartDto {
  @IsIn(OAUTH_MAIL_PROVIDERS) provider!: string;
  @IsOptional() @IsString() @MaxLength(RESUME_MAX) resume?: string;
  @IsOptional() @IsIn(['bot', 'settings']) from?: string;
}

/**
 * Личная почта (ТЗ-18). Всё — только своё: чужой ящик и чужие письма недоступны даже
 * владельцу организации — это переписка человека, а не данные компании.
 */
@ApiTags('mailbox')
@ApiBearerAuth()
@Controller('mailbox')
export class MailboxController {
  constructor(private readonly mail: MailboxService, private readonly oauth: MailOAuthService) {}

  @Get('providers')
  providers() {
    return this.mail.providers();
  }

  // ── #4893: почта кнопкой — Яндекс, Google, Mail.ru по OAuth ──

  /** Какие кнопки включены (есть ли ключи приложения на сервере). */
  @Get('oauth/providers')
  oauthProviders() {
    return this.oauth.providers();
  }

  /** Адрес экрана согласия почтовика; браузер уходит туда целиком (не в окне — мобильные окна режут). */
  @Post('oauth/start')
  oauthStart(@CurrentUser() u: AuthUser, @Body() dto: OAuthStartDto) {
    if (u.role === 'client') throw AppException.forbidden('Почта подключается сотрудниками');
    return this.oauth.start(u.tenantId, u.userId, dto);
  }

  /** Сюда возвращает почтовик — браузером, без нашего токена; кто это, знает подписанный state. */
  @Public()
  @Get('oauth/callback')
  async oauthCallback(@Query() q: { code?: string; state?: string; error?: string }, @Res() res: Response) {
    const r = await this.oauth.callback({ code: q.code, state: q.state, error: q.error });
    // первые письма забираем до возврата (не дольше нескольких секунд) — чтобы бот сразу показал итог
    if (r.accountId) await this.mail.syncSoon(r.accountId);
    res.redirect(302, r.redirect);
  }

  /** «214 писем · важно 6 · можно не читать 202» — первый итог после подключения. */
  @Get('first-summary')
  firstSummary(@CurrentUser() u: AuthUser) {
    return this.mail.firstSummary(u.tenantId, u.userId);
  }

  @Get('accounts')
  accounts(@CurrentUser() u: AuthUser) {
    return this.mail.accounts(u.tenantId, u.userId);
  }

  @Post('accounts')
  connect(@CurrentUser() u: AuthUser, @Body() dto: ConnectDto) {
    if (u.role === 'client') throw AppException.forbidden('Почта подключается сотрудниками');
    return this.mail.connect(u.tenantId, u.userId, dto);
  }

  @Delete('accounts/:id')
  disconnect(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.mail.disconnect(u.tenantId, u.userId, id);
  }

  @Get('messages')
  messages(@CurrentUser() u: AuthUser, @Query('unread') unread?: string, @Query('q') q?: string) {
    return this.mail.inbox(u.tenantId, u.userId, { unreadOnly: unread === '1', q: q ? String(q).slice(0, 100) : null });
  }

  @Get('messages/:id')
  message(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.mail.read(u.tenantId, u.userId, id);
  }
}
