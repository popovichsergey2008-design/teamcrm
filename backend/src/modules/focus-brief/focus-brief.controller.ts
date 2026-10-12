import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { BRIEF_EVENTS, FEEDBACK_REASONS } from './brief-rules';
import { FocusBriefService } from './focus-brief.service';

class FeedbackDto {
  @IsIn([1, -1]) value!: 1 | -1;
  /** 👎 — почему (п. 66) */
  @IsOptional() @IsIn(FEEDBACK_REASONS as unknown as string[]) reason?: string;
}

class EventDto {
  @IsIn(BRIEF_EVENTS as unknown as string[]) event!: string;
}

class SettingsDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/) generateAt?: string;
  @IsOptional() @IsBoolean() audio?: boolean;
  @IsOptional() @IsString() @MaxLength(16) voice?: string;
  @IsOptional() @IsIn(['short', 'normal']) length?: 'short' | 'normal';
  /** null — по пресету роли */
  @IsOptional() @IsBoolean() teamSignals?: boolean | null;
  @IsOptional() @IsBoolean() clients?: boolean | null;
}

/**
 * Персональный брифинг «Фокуса дня» (ТЗ-27, п. 56–57). Всё — только про себя:
 * чужого брифинга не прочитать и не пересобрать ни одной ручкой.
 */
@ApiTags('focus')
@ApiBearerAuth()
@Controller('focus/today')
@Roles('owner', 'manager', 'member')
export class FocusBriefController {
  constructor(private readonly brief: FocusBriefService) {}

  private v(u: AuthUser) {
    return { tenantId: u.tenantId, userId: u.userId, role: u.role };
  }

  @Get('brief')
  view(@CurrentUser() u: AuthUser) {
    return this.brief.view(this.v(u));
  }

  /** Собрать, если ещё не собран (первый вход раньше утреннего тика). */
  @Post('brief/generate')
  async generate(@CurrentUser() u: AuthUser) {
    return this.brief.ensureReady(this.v(u));
  }

  /** «Обновить брифинг»: текст пересобирается, принятая тройка — нет (п. 41–42). */
  @Post('brief/refresh')
  refresh(@CurrentUser() u: AuthUser) {
    return this.brief.refresh(this.v(u));
  }

  @Get('brief/audio')
  audio(@CurrentUser() u: AuthUser) {
    return this.brief.audioView(this.v(u));
  }

  @Post('brief/audio/regenerate')
  regenerate(@CurrentUser() u: AuthUser) {
    return this.brief.regenerateAudio(this.v(u));
  }

  @Post('brief/feedback')
  feedback(@CurrentUser() u: AuthUser, @Body() dto: FeedbackDto) {
    return this.brief.feedback(this.v(u), dto.value, dto.reason ?? null);
  }

  @Post('brief/event')
  event(@CurrentUser() u: AuthUser, @Body() dto: EventDto) {
    return this.brief.track(this.v(u), dto.event);
  }

  @Get('brief/settings')
  settings(@CurrentUser() u: AuthUser) {
    return this.brief.settings(this.v(u));
  }

  @Patch('brief/settings')
  saveSettings(@CurrentUser() u: AuthUser, @Body() dto: SettingsDto) {
    return this.brief.saveSettings(this.v(u), dto);
  }

  /** Как работает брифинг в компании (п. 68) — руководству. */
  @Get('brief/metrics')
  @Roles('owner', 'manager')
  metrics(@CurrentUser() u: AuthUser) {
    return this.brief.metrics(u.tenantId);
  }

  /** «Взять в работу» (п. 24): без таймера — он запускается «Войти в глубокий фокус». */
  @Post('items/:itemId/start')
  start(@CurrentUser() u: AuthUser, @Param('itemId') itemId: string) {
    return this.brief.takeToWork(this.v(u), itemId);
  }
}
