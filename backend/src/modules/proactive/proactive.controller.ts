import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { ProactiveService } from './proactive.service';

class ActDto {
  @IsString() @MaxLength(32) action!: string;
  @IsOptional() @IsObject() params?: Record<string, unknown>;
}
class DismissDto {
  @IsOptional() @IsBoolean() mute?: boolean;
  @IsOptional() @IsString() @MaxLength(24) reason?: string;
}
class SnoozeDto {
  @IsIn(['hour', 'afternoon', 'tomorrow']) preset!: 'hour' | 'afternoon' | 'tomorrow';
}
class FeedbackDto {
  @IsBoolean() useful!: boolean;
  @IsOptional() @IsString() @MaxLength(24) reason?: string;
}
class SeenDto {
  @IsArray() @ArrayMaxSize(200) ids!: string[];
}
class PrefsDto {
  @IsOptional() @IsIn(['normal', 'quiet', 'off']) level?: string;
  @IsOptional() @IsInt() @Min(1) @Max(50) dailyLimit?: number;
  @IsOptional() @IsBoolean() smartReply?: boolean;
  @IsOptional() @IsBoolean() morningAudio?: boolean;
}
class TenantSettingsDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsBoolean() commitments?: boolean;
  @IsOptional() @IsBoolean() workloadGuard?: boolean;
  @IsOptional() @IsBoolean() smartReply?: boolean;
  @IsOptional() @IsBoolean() clientFollowup?: boolean;
  @IsOptional() @IsBoolean() morningAudio?: boolean;
  @IsOptional() @IsBoolean() secondBrain?: boolean;
  @IsOptional() @IsBoolean() externalSend?: boolean;
  @IsOptional() @IsBoolean() telegramDelivery?: boolean;
  @IsOptional() @IsInt() @Min(2) @Max(168) commitmentCheckHours?: number;
  @IsOptional() @IsInt() @Min(4) @Max(336) commitmentEscalateHours?: number;
}

/**
 * Ящик предложений секретаря (ТЗ-21, §98). Сотрудникам; клиентам — нет.
 * Маршруты без `:id` — выше `:id`-маршрутов.
 */
@ApiTags('secretary')
@ApiBearerAuth()
@Controller('assistant/proposals')
@Roles('owner', 'manager', 'member')
export class ProactiveController {
  constructor(private readonly svc: ProactiveService) {}

  private a(u: AuthUser) {
    return { tenantId: u.tenantId, userId: u.userId, role: u.role };
  }

  @Get()
  list(@CurrentUser() u: AuthUser, @Query('section') section?: string, @Query('history') history?: string) {
    return this.svc.list(this.a(u), { section, history: history === '1' || history === 'true' });
  }

  @Get('summary')
  summary(@CurrentUser() u: AuthUser) {
    return this.svc.summary(this.a(u));
  }

  @Post('seen')
  seen(@CurrentUser() u: AuthUser, @Body() dto: SeenDto) {
    return this.svc.seen(this.a(u), dto.ids);
  }

  @Get('prefs')
  prefs(@CurrentUser() u: AuthUser) {
    return this.svc.prefs(this.a(u));
  }

  @Patch('prefs')
  savePrefs(@CurrentUser() u: AuthUser, @Body() dto: PrefsDto) {
    return this.svc.savePrefs(this.a(u), dto);
  }

  @Delete('mutes/:skill')
  unmute(@CurrentUser() u: AuthUser, @Param('skill') skill: string, @Query('kind') kind?: string) {
    return this.svc.unmute(this.a(u), skill, kind ?? '');
  }

  @Get('settings')
  settings(@CurrentUser() u: AuthUser) {
    return this.svc.tenantSettings(this.a(u));
  }

  @Patch('settings')
  saveSettings(@CurrentUser() u: AuthUser, @Body() dto: TenantSettingsDto) {
    return this.svc.saveTenantSettings(this.a(u), dto as Record<string, unknown>);
  }

  @Get('quality')
  quality(@CurrentUser() u: AuthUser, @Query('days') days?: string) {
    return this.svc.quality(this.a(u), Math.min(Math.max(Number(days) || 30, 1), 180));
  }

  @Get(':id')
  get(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.get(this.a(u), id);
  }

  @Post(':id/confirm')
  confirm(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ActDto) {
    return this.svc.act(this.a(u), id, dto.action, dto.params ?? {});
  }

  @Post(':id/dismiss')
  dismiss(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: DismissDto) {
    return this.svc.dismiss(this.a(u), id, dto);
  }

  @Post(':id/snooze')
  snooze(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: SnoozeDto) {
    return this.svc.snooze(this.a(u), id, dto.preset);
  }

  @Post(':id/feedback')
  feedback(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: FeedbackDto) {
    return this.svc.feedback(this.a(u), id, dto.useful, dto.reason ?? null);
  }
}
