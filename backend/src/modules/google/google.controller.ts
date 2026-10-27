import { Body, Controller, Delete, Get, Param, Post, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { CurrentUser, Public } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { GoogleService } from './google-api';
import { GoogleAuthService } from './google-auth.service';
import { GoogleCalendarService } from './google-calendar.service';
import { EntityType, GoogleDriveService } from './google-drive.service';

const ENTITIES = ['task', 'project', 'client', 'event'];

class LinkDto {
  @IsIn(ENTITIES) entityType!: EntityType;
  @IsString() @MaxLength(20) entityId!: string;
  @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) fileIds!: string[];
}

class DocDto {
  @IsIn(ENTITIES) entityType!: EntityType;
  @IsString() @MaxLength(20) entityId!: string;
  @IsOptional() @IsBoolean() blank?: boolean;
}

class CalendarSettingsDto {
  @IsOptional() @IsString() @MaxLength(255) calendarId?: string;
  @IsOptional() @IsString() @MaxLength(255) calendarTitle?: string;
  @IsOptional() @IsBoolean() pushMeetings?: boolean;
  @IsOptional() @IsBoolean() pullEvents?: boolean;
}

/**
 * Google Workspace (#1565): подключение своего Google, файлы Диска при сущностях,
 * документы Google с данными QEVO и Google Календарь.
 */
@ApiTags('google')
@ApiBearerAuth()
@Controller()
export class GoogleController {
  constructor(
    private readonly auth: GoogleAuthService,
    private readonly drive: GoogleDriveService,
    private readonly calendar: GoogleCalendarService,
  ) {}

  private staff(u: AuthUser) {
    if (u.role === 'client') throw AppException.forbidden('Google подключают сотрудники');
  }

  @Get('integrations/google/status')
  status(@CurrentUser() u: AuthUser) {
    return this.auth.status(u.tenantId, u.userId);
  }

  @Get('integrations/google/connect')
  connect(@CurrentUser() u: AuthUser, @Query('service') service?: string, @Query('returnTo') returnTo?: string) {
    this.staff(u);
    const s: GoogleService = service === 'calendar' || service === 'all' ? service : 'drive';
    return this.auth.connectUrl(u.tenantId, u.userId, s, returnTo);
  }

  /** Сюда возвращает Google после согласия — браузером, без нашего токена; кто это, знает state. */
  @Public()
  @Get('integrations/google/callback')
  async callback(@Query() q: { code?: string; state?: string; error?: string }, @Res() res: Response) {
    res.redirect(302, await this.auth.callback(q));
  }

  @Delete('integrations/google')
  disconnect(@CurrentUser() u: AuthUser) {
    return this.auth.disconnect(u.tenantId, u.userId);
  }

  @Post('integrations/google/picker-token')
  pickerToken(@CurrentUser() u: AuthUser) {
    this.staff(u);
    return this.auth.pickerToken(u.tenantId, u.userId);
  }

  // ── Диск и Документы ──

  @Get('google-drive/links')
  links(@CurrentUser() u: AuthUser, @Query('entityType') type: string, @Query('entityId') id: string) {
    if (!ENTITIES.includes(type)) throw AppException.validation('Неизвестный раздел');
    return this.drive.list(u, type as EntityType, String(id ?? ''));
  }

  @Post('google-drive/links')
  link(@CurrentUser() u: AuthUser, @Body() dto: LinkDto) {
    return this.wrap(this.drive.link(u, dto.entityType, dto.entityId, dto.fileIds));
  }

  @Delete('google-drive/links/:id')
  unlink(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.drive.unlink(u, id);
  }

  @Post('google-docs/create')
  createDoc(@CurrentUser() u: AuthUser, @Body() dto: DocDto) {
    return this.wrap(this.drive.createDoc(u, dto.entityType, dto.entityId, dto.blank));
  }

  // ── Календарь ──

  @Get('google-calendar/calendars')
  calendars(@CurrentUser() u: AuthUser) {
    return this.wrap(this.calendar.calendars(u.tenantId, u.userId));
  }

  @Get('google-calendar/settings')
  calendarSettings(@CurrentUser() u: AuthUser) {
    return this.calendar.getSettings(u.tenantId, u.userId);
  }

  @Put('google-calendar/settings')
  saveCalendarSettings(@CurrentUser() u: AuthUser, @Body() dto: CalendarSettingsDto) {
    this.staff(u);
    return this.wrap(this.calendar.saveSettings(u.tenantId, u.userId, dto));
  }

  @Post('google-calendar/sync')
  sync(@CurrentUser() u: AuthUser) {
    this.staff(u);
    return this.wrap(this.calendar.syncNow(u.tenantId, u.userId));
  }

  /** Ошибку Google — словами человеку, а не «500». */
  private async wrap<T>(p: Promise<T>): Promise<T> {
    try {
      return await p;
    } catch (e) {
      const human = GoogleDriveService.humanError(e);
      if (human) throw AppException.validation(human);
      throw e;
    }
  }
}
