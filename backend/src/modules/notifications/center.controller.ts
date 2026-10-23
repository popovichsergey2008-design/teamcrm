import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min,
} from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { CENTER_CATEGORIES } from './center.repository';
import { NotificationCenter } from './center.service';

class ListQuery {
  @IsOptional() @Matches(/^\d{1,18}$/) before?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
  /** «Непрочитанные» — строкой из адреса: `unread=1`. */
  @IsOptional() @IsIn(['0', '1']) unread?: string;
  @IsOptional() @IsIn(CENTER_CATEGORIES as unknown as string[]) category?: string;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

class ReadDto {
  @IsArray() @ArrayMaxSize(200) @Matches(/^\d{1,18}$/, { each: true }) ids!: string[];
}

class ReadAllDto {
  @IsOptional() @IsIn(CENTER_CATEGORIES as unknown as string[]) category?: string;
}

/**
 * Центр уведомлений (#4655): история, значок непрочитанного, «Прочитать все».
 *
 * Всё — только своё и только в своей компании: строка ящика принадлежит человеку,
 * а запись о задаче видна, пока ему видна сама задача (условие в репозитории).
 */
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications/center')
@Roles('owner', 'manager', 'member')
export class NotificationCenterController {
  constructor(private readonly center: NotificationCenter) {}

  @Get()
  list(@CurrentUser() u: AuthUser, @Query() q: ListQuery) {
    return this.center.list(u, {
      before: q.before ?? null,
      limit: q.limit ?? 30,
      unreadOnly: q.unread === '1',
      category: q.category ?? null,
      q: q.q?.trim() || null,
    });
  }

  /** Число на значке: дешёвый запрос на каждое событие сокета. */
  @Get('unread')
  async unread(@CurrentUser() u: AuthUser) {
    return { unread: await this.center.unread(u) };
  }

  @Post('read')
  read(@CurrentUser() u: AuthUser, @Body() dto: ReadDto) {
    return this.center.read(u, dto.ids);
  }

  @Post('read-all')
  readAll(@CurrentUser() u: AuthUser, @Body() dto: ReadAllDto) {
    return this.center.readAll(u, dto.category ?? null);
  }
}
