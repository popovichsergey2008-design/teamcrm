import { Body, Controller, Delete, Get, Param, Post, Query, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { AnyFilesInterceptor, FileInterceptor } from '@nestjs/platform-express';
import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { CurrentUser, Public, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { InboxService } from './inbox.service';

class CreateSourceDto {
  @IsOptional() @IsString() @MaxLength(120) label?: string;
  @IsOptional() @IsString() defaultProjectId?: string;
}
class ConfirmDto {
  @IsObject() task!: Record<string, unknown>;
}

/** Авто-задачи из переписок: управление каналами и ревью черновиков (owner/manager). */
@ApiTags('inbox')
@ApiBearerAuth()
@Controller('inbox')
@Roles('owner', 'manager')
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  @Post('sources')
  createSource(@CurrentUser() u: AuthUser, @Body() dto: CreateSourceDto) {
    return this.inbox.createSource(u.tenantId, u.userId, dto.label, dto.defaultProjectId);
  }
  @Get('sources')
  listSources(@CurrentUser() u: AuthUser) {
    return this.inbox.listSources(u.tenantId);
  }
  @Delete('sources/:id')
  deleteSource(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.inbox.deleteSource(u.tenantId, id);
  }

  /** Голосовая заметка: надиктовал (multipart 'audio') → Whisper → черновик задачи на ревью. */
  @Post('voice')
  @UseInterceptors(FileInterceptor('audio', { limits: { fileSize: 25 * 1024 * 1024 } }))
  voice(@CurrentUser() u: AuthUser, @Body('defaultProjectId') defaultProjectId?: string, @UploadedFile() file?: Express.Multer.File) {
    if (!file?.buffer?.length) throw AppException.validation('Аудио не получено');
    return this.inbox.captureVoice(u.tenantId, u.userId, file.buffer, file.originalname || 'note.webm', defaultProjectId);
  }

  @Get('items')
  listItems(@CurrentUser() u: AuthUser, @Query('status') status?: string) {
    return this.inbox.listItems(u.tenantId, status || 'pending');
  }
  @Post('items/:id/confirm')
  confirm(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ConfirmDto) {
    return this.inbox.confirm(u.tenantId, u.userId, id, dto.task);
  }
  @Post('items/:id/dismiss')
  dismiss(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.inbox.dismiss(u.tenantId, id);
  }
}

/** Публичный приёмник входящих сообщений (почта/мессенджер/Zapier). Маршрутизация по секретному token. */
@ApiTags('inbox')
@Controller('inbox/hook')
export class InboxHookController {
  constructor(private readonly inbox: InboxService) {}

  // Mailgun/Postmark inbound шлют multipart/form-data (текстовые поля + вложения).
  // Multer разбирает поля в req.body; вложения не сохраняем — inbox работает только с текстом.
  // Лимиты щедрые (крупные HTML-письма, вложения-подписи), чтобы вебхук не падал 413/500 → без ретраев.
  @Public()
  @Post(':token')
  @UseInterceptors(AnyFilesInterceptor({ limits: { fileSize: 25 * 1024 * 1024, files: 25, fieldSize: 10 * 1024 * 1024 } }))
  receive(@Param('token') token: string, @Req() req: Request) {
    return this.inbox.receive(token, req.body);
  }
}
