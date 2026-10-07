import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentUser } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
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

/**
 * Личная почта (ТЗ-18). Всё — только своё: чужой ящик и чужие письма недоступны даже
 * владельцу организации — это переписка человека, а не данные компании.
 */
@ApiTags('mailbox')
@ApiBearerAuth()
@Controller('mailbox')
export class MailboxController {
  constructor(private readonly mail: MailboxService) {}

  @Get('providers')
  providers() {
    return this.mail.providers();
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
