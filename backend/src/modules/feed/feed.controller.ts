import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { FeedService } from './feed.service';

class PostDto {
  @IsString() @MinLength(1) @MaxLength(8000) body!: string;
  /** Объявление: цветная плашка и подтверждение прочтения. Только владелец и руководитель. */
  @IsOptional() @IsBoolean() isAnnouncement?: boolean;
  /** До какого момента объявление действует. Пусто — бессрочно. */
  @IsOptional() @IsDateString() activeUntil?: string;
  /** Кому: подразделения. Пусто — всей компании. */
  @IsOptional() @IsArray() @ArrayMaxSize(30) groupIds?: string[];
}

class CommentDto {
  @IsString() @MinLength(1) @MaxLength(4000) body!: string;
}

class PinDto {
  @IsBoolean() pinned!: boolean;
}

/** Лента компании: сообщения и объявления. Заказчику (роль client) не показывается. */
@ApiTags('feed')
@ApiBearerAuth()
@Controller('feed')
@Roles('owner', 'manager', 'member')
export class FeedController {
  constructor(private readonly feed: FeedService) {}

  @Get()
  list(@CurrentUser() u: AuthUser, @Query('before') before?: string, @Query('limit') limit?: string) {
    return this.feed.list(u.tenantId, u.userId, Number(limit ?? 20) || 20, before);
  }

  /** Непрочитанные действующие объявления — плашка сверху и счётчик в меню. */
  @Get('unread')
  unread(@CurrentUser() u: AuthUser) {
    return this.feed.unread(u.tenantId, u.userId);
  }

  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: PostDto) {
    return this.feed.create(u.tenantId, u, dto);
  }

  @Post(':id/read')
  read(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.feed.read(u.tenantId, u.userId, id);
  }

  @Get(':id/readers')
  readers(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.feed.readers(u.tenantId, u, id);
  }

  @Get(':id/comments')
  comments(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.feed.comments(u.tenantId, id);
  }

  @Post(':id/comments')
  comment(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: CommentDto) {
    return this.feed.comment(u.tenantId, u.userId, id, dto.body);
  }

  @Post(':id/pin')
  pin(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: PinDto) {
    return this.feed.pin(u.tenantId, u, id, dto.pinned);
  }

  @Delete(':id')
  remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.feed.remove(u.tenantId, u, id);
  }
}
