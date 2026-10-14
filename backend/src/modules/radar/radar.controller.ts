import { Body, Controller, Get, Header, Param, Patch, Post, Query } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { RadarService } from './radar.service';
import { PulseService } from './pulse.service';
import { ChangesService } from './changes.service';

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
/** Балансировка с ручным выбором (#1575): кому передать каждую задачу; toId пустой — не передавать. */
class MoveDto {
  @IsString() @MaxLength(20) taskId!: string;
  @IsOptional() @IsString() @MaxLength(20) toId?: string | null;
}
class ConfirmDto {
  @IsOptional() @IsArray() @ArrayMaxSize(40) @ValidateNested({ each: true }) @Type(() => MoveDto) moves?: MoveDto[];
}
class TargetDto { @IsOptional() @IsString() @MaxLength(10) date?: string | null; }
/** Изменения по задачам (ТЗ-32): период — местные дни, пояс — смотрящего. */
class ChangesQuery {
  @IsString() @MaxLength(10) from!: string;
  @IsString() @MaxLength(10) to!: string;
  @IsOptional() @IsString() @MaxLength(64) tz?: string;
  @IsOptional() @IsString() @MaxLength(20) projectId?: string;
  @IsOptional() @IsString() @MaxLength(20) userId?: string;
  @IsOptional() @IsIn(['actor', 'assignee']) by?: 'actor' | 'assignee';
  @IsOptional() @IsString() @MaxLength(24) kind?: string;
  @IsOptional() @IsString() @MaxLength(20) cursor?: string;
}
class NormDto { @IsOptional() @Type(() => Number) @IsInt() @Min(2) @Max(60) norm?: number | null; }

/** «Пульс команды» — экран руководителя. Рядовому сотруднику он не показывается. */
@ApiTags('radar')
@ApiBearerAuth()
@Controller('radar')
export class RadarController {
  constructor(private readonly radar: RadarService, private readonly pulse: PulseService, private readonly changes: ChangesService) {}

  /** Сколько задач ушло в тест, вернулось, закрыто, переоткрыто — и кто двигал (ТЗ-32). */
  @Get('changes')
  changesSummary(@CurrentUser() u: AuthUser, @Query() q: ChangesQuery) {
    return this.changes.summary(u, q);
  }

  /** Конкретные переходы по клику на цифру. */
  @Get('changes/events')
  changeEvents(@CurrentUser() u: AuthUser, @Query() q: ChangesQuery) {
    return this.changes.events(u, q);
  }

  @Get('changes/export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="task-changes.csv"')
  changesExport(@CurrentUser() u: AuthUser, @Query() q: ChangesQuery) {
    return this.changes.exportCsv(u, q);
  }

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
  confirm(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ConfirmDto) {
    return this.pulse.confirm(u, id, dto?.moves);
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
