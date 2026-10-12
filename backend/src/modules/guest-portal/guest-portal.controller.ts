import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { Request, Response } from 'express';
import { CurrentUser, Public, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { SecurityService } from '../security/security.service';
import { GuestPortalService } from './guest-portal.service';
import { FEEDBACK_KINDS, GUEST_EVENTS, SIDES } from './guest-rules';

class GuestCredDto {
  /** ключ гостевой сессии — у вошедшего по ссылке */
  @IsOptional() @IsString() @MaxLength(64) session?: string;
  /** персональная ссылка из письма */
  @IsOptional() @IsString() @MaxLength(128) token?: string;
}

class AckDto extends GuestCredDto {
  @IsInt() @Min(1) version!: number;
}

class FeedbackDto extends GuestCredDto {
  @IsIn(FEEDBACK_KINDS as unknown as string[]) kind!: string;
  @IsString() @MaxLength(2000) body!: string;
}

class EventDto extends GuestCredDto {
  @IsOptional() @IsString() @MaxLength(16) publicId?: string;
  @IsIn(GUEST_EVENTS as unknown as string[]) event!: string;
}

class AgreementDto {
  @IsString() @MaxLength(500) text!: string;
  @IsIn(SIDES) side!: string;
  @IsOptional() @IsISO8601() deadlineAt?: string | null;
}

class NextMeetingDto {
  @IsString() @MaxLength(255) title!: string;
  @IsISO8601() at!: string;
  @IsOptional() @IsString() @MaxLength(500) url?: string | null;
}

class SaveSummaryDto {
  @IsString() @MaxLength(8) language!: string;
  @IsString() @MaxLength(3000) text!: string;
  @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => AgreementDto) agreements!: AgreementDto[];
  @IsOptional() @ValidateNested() @Type(() => NextMeetingDto) nextMeeting?: NextMeetingDto | null;
}

class DraftDto {
  @IsOptional() @IsString() @MaxLength(8) language?: string;
}

class FileDto {
  @IsString() fileId!: string;
}

class BrandDto {
  @IsOptional() @IsString() @MaxLength(120) companyName?: string | null;
  @IsOptional() @IsString() logoFileId?: string | null;
  @IsOptional() @IsString() @MaxLength(7) accent?: string | null;
  @IsOptional() @IsIn(['plain', 'soft', 'gradient']) background?: string;
  @IsOptional() @IsString() @MaxLength(400) welcomeText?: string | null;
  @IsOptional() @IsString() @MaxLength(200) footerText?: string | null;
  @IsOptional() @IsBoolean() poweredBy?: boolean;
  @IsOptional() @IsBoolean() recordingNotice?: boolean;
  @IsOptional() @IsBoolean() consentRequired?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(365) summaryDays?: number;
}

/**
 * Простой предохранитель от перебора и спама с одного адреса (п. 77): гостевые
 * маршруты публичны. Счётчик в памяти процесса — грубо, но достаточно для гостевых
 * ответов; сами токены неугадываемы.
 */
const hits = new Map<string, { n: number; until: number }>();
function limit(req: Request, bucket: string, max: number, windowMs = 60_000) {
  const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.until < now) { hits.set(key, { n: 1, until: now + windowMs }); return; }
  if (++h.n > max) throw AppException.conflict('Слишком много запросов — попробуйте через минуту');
  if (hits.size > 50_000) hits.clear();
}

/**
 * Гостевой портал глазами клиента (ТЗ-28, п. 59). Публичные маршруты: у гостя нет
 * учётной записи. Доступ — по ключу гостевой сессии или персональной ссылке; во
 * внутреннюю CRM отсюда не ведёт ничего (п. 17).
 */
@ApiTags('guest')
@Controller('guest')
@Public()
export class GuestPublicController {
  constructor(private readonly portal: GuestPortalService) {}

  /** Бренд страницы: по общей ссылке, персональной или сессии. */
  @Get('brand')
  async brand(@Req() req: Request, @Query('publicId') publicId?: string, @Query('token') token?: string, @Query('session') session?: string) {
    limit(req, 'brand', 120);
    return (await this.portal.brandFor({ publicId, token, session })) ?? { companyName: null };
  }

  @Post('postcall')
  postcall(@Req() req: Request, @Body() dto: GuestCredDto) {
    limit(req, 'postcall', 60);
    return this.portal.postcall(dto);
  }

  @Post('postcall/acknowledge')
  acknowledge(@Req() req: Request, @Body() dto: AckDto) {
    limit(req, 'ack', 20);
    return this.portal.acknowledge(dto, dto.version);
  }

  @Post('postcall/feedback')
  feedback(@Req() req: Request, @Body() dto: FeedbackDto) {
    limit(req, 'feedback', 10);
    return this.portal.feedback(dto, dto.kind, dto.body);
  }

  @Post('postcall/files/:fileId')
  file(@Req() req: Request, @Param('fileId') fileId: string, @Body() dto: GuestCredDto) {
    limit(req, 'file', 30);
    return this.portal.file(dto, fileId);
  }

  @Get('postcall/next.ics')
  async ics(@Req() req: Request, @Res() res: Response, @Query('session') session?: string, @Query('token') token?: string) {
    limit(req, 'ics', 20);
    const body = await this.portal.ics({ session, token });
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="meeting.ics"');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.send(body);
  }

  @Post('event')
  event(@Req() req: Request, @Body() dto: EventDto) {
    limit(req, 'event', 60);
    return this.portal.track(dto, dto.event);
  }
}

/** Клиентский протокол глазами хозяина встречи (п. 33, 60). */
@ApiTags('guest')
@ApiBearerAuth()
@Controller()
@Roles('owner', 'manager', 'member')
export class GuestHostController {
  constructor(private readonly portal: GuestPortalService, private readonly security: SecurityService) {}

  private u(u: AuthUser) {
    return { tenantId: u.tenantId, userId: u.userId, role: u.role };
  }

  @Get('meetings/:id/guest-summary')
  view(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.portal.hostView(this.u(u), id);
  }

  /** Подготовить или пересобрать черновик (моделью, если есть ключ). */
  @Post('meetings/:id/guest-summary/draft')
  draft(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: DraftDto) {
    return this.portal.draft(this.u(u), id, dto);
  }

  @Put('meetings/:id/guest-summary')
  save(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: SaveSummaryDto) {
    return this.portal.save(this.u(u), id, dto);
  }

  @Post('meetings/:id/guest-summary/publish')
  publish(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.portal.publish(this.u(u), id);
  }

  @Post('meetings/:id/guest-summary/files')
  addFile(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: FileDto) {
    return this.portal.addFile(this.u(u), id, dto.fileId);
  }

  @Delete('meetings/:id/guest-summary/files/:fileId')
  removeFile(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('fileId') fileId: string) {
    return this.portal.removeFile(this.u(u), id, fileId);
  }

  @Post('meetings/:id/guest-summary/feedback/:feedbackId/handled')
  handled(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('feedbackId') feedbackId: string) {
    return this.portal.handleFeedback(this.u(u), id, feedbackId);
  }

  // ── бренд (п. 67) ──

  @Get('settings/guest-brand')
  brand(@CurrentUser() u: AuthUser) {
    return this.portal.brandSettings(u.tenantId);
  }

  @Patch('settings/guest-brand')
  async saveBrand(@CurrentUser() u: AuthUser, @Body() dto: BrandDto) {
    await this.security.require(u.tenantId, u.userId, 'organization.manage', 'Бренд гостевых страниц настраивает владелец организации');
    return this.portal.saveBrand(u.tenantId, dto);
  }

  @Get('settings/guest-brand/metrics')
  @Roles('owner', 'manager')
  metrics(@CurrentUser() u: AuthUser) {
    return this.portal.metrics(u.tenantId);
  }
}
