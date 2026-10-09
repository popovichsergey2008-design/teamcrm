import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { RadarService } from './radar.service';
import { PulseService } from './pulse.service';

class ActionDto {
  @IsIn(['TASK_NUDGE', 'TASK_REASSIGN', 'TASK_RESCHEDULE', 'TASK_CREATE_MEETING', 'REVIEW_REMINDER', 'TASK_FOCUS', 'PUBLISH_NEWS'])
  type!: 'TASK_NUDGE' | 'TASK_REASSIGN' | 'TASK_RESCHEDULE' | 'TASK_CREATE_MEETING' | 'REVIEW_REMINDER' | 'TASK_FOCUS' | 'PUBLISH_NEWS';
  @IsOptional() @IsString() @MaxLength(20) taskId?: string;
  @IsOptional() @IsString() @MaxLength(20) toUserId?: string;
  @IsOptional() @IsString() @MaxLength(40) date?: string;
  @IsOptional() @IsString() @MaxLength(2000) text?: string;
}
class FeedbackDto {
  @IsIn(['bottleneck', 'decision', 'workload', 'forecast', 'project']) kind!: string;
  @IsString() @MaxLength(64) ref!: string;
  @IsIn(['not_stuck', 'load_wrong', 'not_critical', 'outdated', 'other']) reason!: string;
}
class TargetDto { @IsOptional() @IsString() @MaxLength(10) date?: string | null; }
class NormDto { @IsOptional() @Type(() => Number) @IsInt() @Min(2) @Max(60) norm?: number | null; }

/** «Пульс команды» — экран руководителя. Рядовому сотруднику он не показывается. */
@ApiTags('radar')
@ApiBearerAuth()
@Controller('radar')
export class RadarController {
  constructor(private readonly radar: RadarService, private readonly pulse: PulseService) {}

  /** @param tz смещение часового пояса в минутах (Date#getTimezoneOffset). Прежняя сводка — её читают выпущенные приложения. */
  @Get()
  @Roles('owner', 'manager')
  overview(@CurrentUser() user: AuthUser, @Query('tz') tz?: string) {
    return this.radar.overview(user.tenantId, user.userId, Number.parseInt(tz ?? '0', 10) || 0);
  }

  /** Командный центр (ТЗ-19): всё для экрана одним запросом. tz — пояс смотрящего (IANA). */
  @Get('summary')
  summary(@CurrentUser() u: AuthUser, @Query('tz') tz?: string) {
    return this.pulse.summary(u, tz ? String(tz).slice(0, 64) : null);
  }

  /** Действие: сначала предпросмотр, ничего не меняет. */
  @Post('actions/preview')
  preview(@CurrentUser() u: AuthUser, @Body() dto: ActionDto) {
    return this.pulse.preview(u, dto);
  }

  @Post('actions/:id/confirm')
  confirm(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.pulse.confirm(u, id);
  }

  @Post('actions/:id/reject')
  reject(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.pulse.reject(u, id);
  }

  /** Кого и чем разгрузить — предложение с «было → станет», подтверждается как действие. */
  @Post('rebalance/:userId/preview')
  rebalance(@CurrentUser() u: AuthUser, @Param('userId') userId: string) {
    return this.pulse.rebalancePreview(u, userId);
  }

  /** «Это не проблема» — пункт скрывается на неделю, причина копится для правил. */
  @Post('feedback')
  feedback(@CurrentUser() u: AuthUser, @Body() dto: FeedbackDto) {
    return this.pulse.feedback(u, dto.kind, dto.ref, dto.reason);
  }

  /** Срок проекта — для прогноза «план против прогноза». Пусто — снять. */
  @Patch('projects/:id/target')
  target(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: TargetDto) {
    return this.pulse.setTargetDate(u, id, dto.date || null);
  }

  /** Норма нагрузки человека в очках (владелец). Пусто — по умолчанию. */
  @Patch('people/:id/norm')
  norm(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: NormDto) {
    return this.pulse.setNorm(u, id, dto.norm ?? null);
  }
}
