import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  ArrayMaxSize, IsArray, IsEmail, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min,
} from 'class-validator';
import { CurrentUser, Public, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AuthThrottleService } from '../auth/auth-throttle.service';
import { FilesService } from '../files/files.service';
import { BookingService } from './booking.service';
import type { Weekly } from '../calendar/booking-slots';

class TypeDto {
  @IsString() @MaxLength(160) title!: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsInt() @Min(5) @Max(480) durationMin!: number;
  @IsOptional() @IsObject() weekly?: Weekly | null;
  @IsOptional() @IsIn(['call', 'place', 'phone']) locationKind?: 'call' | 'place' | 'phone';
  @IsOptional() @IsString() @MaxLength(255) location?: string;
  @IsOptional() @IsInt() @Min(0) @Max(240) bufferBefore?: number;
  @IsOptional() @IsInt() @Min(0) @Max(240) bufferAfter?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(10) questions?: { text: string; required?: boolean }[];
  @IsOptional() @IsArray() @ArrayMaxSize(6) @IsInt({ each: true }) reminders?: number[];
}

class RulesDto {
  @IsObject() weekly!: Weekly;
  @IsOptional() @IsArray() @ArrayMaxSize(366) @IsString({ each: true }) blockedDates?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(50) vacations?: { from: string; to: string }[];
  @IsOptional() maxPerDay?: number | null;
  @IsOptional() @IsInt() @Min(0) @Max(20160) minNoticeMin?: number;
  @IsOptional() @IsInt() @Min(1) @Max(365) horizonDays?: number;
  @IsOptional() @IsString() @MaxLength(64) timezone?: string;
}

class BookDto {
  @IsString() startsAt!: string;
  @IsString() @MaxLength(120) name!: string;
  @IsEmail() @MaxLength(320) email!: string;
  @IsOptional() @IsString() @MaxLength(64) timeZone?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) answers?: string[];
}

class MoveDto {
  @IsString() startsAt!: string;
}

/** Гость записывается не чаще: страница открыта всем, перебор слотов и почты не нужен. */
const BOOK_IP = { name: 'booking:ip', limit: 20, windowSec: 60 * 60 };
const VIEW_IP = { name: 'booking:view', limit: 300, windowSec: 10 * 60 };

/** «Поделиться временем» (#4787, п. 6–8): виды встреч и правила — у самого человека. */
@ApiTags('calendar')
@ApiBearerAuth()
@Controller('calendar/booking')
@Roles('owner', 'manager', 'member')
export class BookingController {
  constructor(private readonly booking: BookingService) {}

  @Get('types')
  types(@CurrentUser() u: AuthUser) { return this.booking.types(u.tenantId, u.userId); }

  @Post('types')
  create(@CurrentUser() u: AuthUser, @Body() dto: TypeDto) { return this.booking.createType(u.tenantId, u.userId, dto); }

  @Patch('types/:id')
  update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: TypeDto) { return this.booking.updateType(u.tenantId, u.userId, id, dto); }

  @Delete('types/:id')
  remove(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.booking.removeType(u.tenantId, u.userId, id); }

  @Get('rules')
  rules(@CurrentUser() u: AuthUser) { return this.booking.rules(u.tenantId, u.userId); }

  @Put('rules')
  saveRules(@CurrentUser() u: AuthUser, @Body() dto: RulesDto) { return this.booking.saveRules(u.tenantId, u.userId, dto); }

  @Get('upcoming')
  upcoming(@CurrentUser() u: AuthUser) { return this.booking.upcoming(u.tenantId, u.userId); }
}

/** Страница записи для гостя — без входа (п. 6, 9). */
@ApiTags('booking')
@Controller('book')
export class BookingPublicController {
  constructor(
    private readonly booking: BookingService,
    private readonly throttle: AuthThrottleService,
    private readonly files: FilesService,
  ) {}

  @Public()
  @Get('manage/:token')
  async manage(@Param('token') token: string, @Req() req: Request) {
    await this.throttle.hit(VIEW_IP, req.ip);
    return this.booking.manage(token);
  }

  @Public()
  @Post('manage/:token/reschedule')
  async reschedule(@Param('token') token: string, @Body() dto: MoveDto, @Req() req: Request) {
    await this.throttle.hit(BOOK_IP, req.ip);
    return this.booking.reschedule(token, dto.startsAt);
  }

  @Public()
  @Post('manage/:token/cancel')
  async cancel(@Param('token') token: string, @Req() req: Request) {
    await this.throttle.hit(BOOK_IP, req.ip);
    return this.booking.cancel(token);
  }

  @Public()
  @Get(':slug')
  async page(@Param('slug') slug: string, @Req() req: Request) {
    await this.throttle.hit(VIEW_IP, req.ip);
    return this.booking.page(slug);
  }

  /** Фото организатора: файлы закрыты входом, а гостю оно нужно на странице записи. */
  @Public()
  @Get(':slug/avatar')
  async avatar(@Param('slug') slug: string, @Res() res: Response) {
    const a = await this.booking.avatar(slug);
    const { file, stream } = await this.files.getForDownload(a.tenantId, a.fileId);
    res.setHeader('Content-Type', file.content_type || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    stream.pipe(res);
  }

  @Public()
  @Post(':slug')
  async book(@Param('slug') slug: string, @Body() dto: BookDto, @Req() req: Request) {
    await this.throttle.hit(BOOK_IP, req.ip);
    return this.booking.book(slug, dto);
  }
}
