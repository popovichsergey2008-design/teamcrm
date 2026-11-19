import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsNumber, IsObject, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { StickersService } from './stickers.service';

class ParseDto {
  @IsString() @MaxLength(4000) text!: string;
}
class CreateDto {
  @IsString() @MaxLength(6000) text!: string;
  /** null — «Без даты»; не передано — из текста. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() date?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() time?: string | null;
  @IsOptional() @IsString() @MaxLength(16) color?: string;
  @IsOptional() @IsIn(['manual', 'voice', 'bot', 'chat', 'telegram']) source?: string;
  /** Откуда стикер: сообщение чата (chatId, messageId) — ссылка «открыть сообщение». */
  @IsOptional() @IsObject() sourceRef?: Record<string, unknown>;
  /** Дня нет ни в тексте, ни в запросе: «Без даты» (по умолчанию) или «Сегодня» — голосом с кнопки бота. */
  @IsOptional() @IsIn(['today', 'none']) fallback?: 'today' | 'none';
}
class UpdateDto {
  @IsOptional() @IsString() @MaxLength(500) text?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() date?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() time?: string | null;
  @IsOptional() @IsString() @MaxLength(16) color?: string;
  @IsOptional() @IsNumber() position?: number;
  /** «Сделать задачей» / «В календарь» (пункт 7): ссылка на созданное. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() taskId?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() eventId?: string | null;
}
class MarkDto {
  @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) ids!: string[];
  @IsIn(['done', 'undone', 'delete', 'restore']) action!: 'done' | 'undone' | 'delete' | 'restore';
}
class ColorsDto {
  @IsObject() names!: Record<string, string>;
}

/** Стикеры-напоминалки (#4997). Личные: каждый запрос — только свои стикеры. */
@ApiTags('stickers')
@ApiBearerAuth()
@Controller('stickers')
@Roles('owner', 'manager', 'member')
export class StickersController {
  constructor(private readonly svc: StickersService) {}

  @Get()
  board(@CurrentUser() u: AuthUser) {
    return this.svc.board(u.tenantId, u.userId);
  }

  @Get('archive')
  archive(@CurrentUser() u: AuthUser, @Query('kind') kind?: string) {
    return this.svc.archive(u.tenantId, u.userId, kind === 'trash' ? 'trash' : 'done');
  }

  @Get('day')
  day(@CurrentUser() u: AuthUser, @Query('date') date?: string) {
    return this.svc.forDay(u.tenantId, u.userId, date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined);
  }

  @Post('parse')
  @HttpCode(200)
  parse(@CurrentUser() u: AuthUser, @Body() dto: ParseDto) {
    return this.svc.parse(u.tenantId, u.userId, dto.text);
  }

  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateDto) {
    return this.svc.create(u.tenantId, u.userId, { ...dto, fallbackDate: dto.fallback ?? 'none' });
  }

  @Patch(':id')
  update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpdateDto) {
    return this.svc.update(u.tenantId, u.userId, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.mark(u.tenantId, u.userId, [id], 'delete');
  }

  @Post('mark')
  @HttpCode(200)
  mark(@CurrentUser() u: AuthUser, @Body() dto: MarkDto) {
    return this.svc.mark(u.tenantId, u.userId, dto.ids, dto.action);
  }

  @Post('overdue-to-today')
  @HttpCode(200)
  overdue(@CurrentUser() u: AuthUser) {
    return this.svc.overdueToToday(u.tenantId, u.userId);
  }

  @Put('colors')
  colors(@CurrentUser() u: AuthUser, @Body() dto: ColorsDto) {
    return this.svc.setColorNames(u.tenantId, u.userId, dto.names);
  }
}
