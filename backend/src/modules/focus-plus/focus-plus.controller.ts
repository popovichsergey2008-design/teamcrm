import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { DbService } from '../../database/db.service';
import { AppException } from '../../common/http/app-exception';
import { FocusPlusService } from './focus-plus.service';
import { FocusWave2Service } from './focus-wave2.service';

class NoteDto {
  @IsOptional() @IsString() @MaxLength(500) nextStep?: string | null;
  @IsOptional() @IsString() @MaxLength(500) result?: string | null;
  @IsOptional() @IsString() @MaxLength(300) stepDone?: string | null;
}
class EstimateDto {
  @IsInt() @Min(5) @Max(2400) minutes!: number;
}
class SnoozeDto {
  @IsString() @MaxLength(80) key!: string;
  @IsDateString() until!: string;
  @IsOptional() @IsBoolean() remind?: boolean;
}
class PlacementDto {
  @IsString() taskId!: string;
  @IsDateString() startsAt!: string;
  @IsDateString() endsAt!: string;
}
class PlacementsDto {
  @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => PlacementDto) placements!: PlacementDto[];
}
class ExtendDto {
  @IsInt() @Min(5) @Max(60) minutes!: number;
}
class AfterDto {
  @IsOptional() @IsString() taskId?: string | null;
  @IsInt() @Min(0) @Max(600) minutes!: number;
}

class KeyDto {
  @IsString() @MaxLength(80) key!: string;
}
class AttachDto {
  @IsString() taskId!: string;
}
class CloseItemDto {
  @IsString() itemId!: string;
  @IsOptional() @IsString() taskId?: string | null;
  @IsOptional() @IsString() @MaxLength(500) nextStep?: string | null;
  @IsIn(['tomorrow', 'date', 'inbox']) when!: 'tomorrow' | 'date' | 'inbox';
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) date?: string | null;
}
class CloseDto {
  @IsOptional() @IsString() @MaxLength(500) startWith?: string | null;
  @IsBoolean() quiet!: boolean;
  @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => CloseItemDto) items!: CloseItemDto[];
}
class FirstDayDto {
  @Matches(/^\d{2}:\d{2}$/) workStart!: string;
  @Matches(/^\d{2}:\d{2}$/) workEnd!: string;
  @IsString() @MinLength(3) @MaxLength(1500) text!: string;
}

/** «Фокус дня» #4891: план по часам, ёмкость, перегруз, оценки, шаги, проверки. */
@ApiTags('focus')
@ApiBearerAuth()
@Controller('focus/plus')
@Roles('owner', 'manager', 'member')
export class FocusPlusController {
  constructor(private readonly svc: FocusPlusService, private readonly w2: FocusWave2Service, private readonly db: DbService) {}

  private v(u: AuthUser) { return { tenantId: u.tenantId, userId: u.userId, role: u.role }; }

  @Get('day')
  day(@CurrentUser() u: AuthUser) { return this.svc.day(this.v(u)); }

  @Post('accept')
  accept(@CurrentUser() u: AuthUser) { return this.svc.accept(this.v(u)); }

  @Post('accept-anyway')
  acceptAnyway(@CurrentUser() u: AuthUser) { return this.svc.acceptAnyway(this.v(u)); }

  @Post('overload/apply')
  overload(@CurrentUser() u: AuthUser) { return this.svc.applyOverload(this.v(u)); }

  @Post('overdue/preview')
  overduePreview(@CurrentUser() u: AuthUser) { return this.svc.overduePreview(this.v(u)); }

  @Post('overdue/apply')
  overdueApply(@CurrentUser() u: AuthUser, @Body() dto: PlacementsDto) { return this.svc.overdueApply(this.v(u), dto.placements); }

  @Post('tasks/:id/estimate/suggest')
  suggest(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.suggestEstimate(this.v(u), id); }

  @Post('tasks/:id/estimate')
  confirm(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: EstimateDto) { return this.svc.confirmEstimate(this.v(u), id, dto.minutes); }

  @Get('tasks/:id/note')
  note(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.note(this.v(u), id); }

  @Put('tasks/:id/note')
  saveNote(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: NoteDto) { return this.svc.saveNote(this.v(u), id, dto); }

  @Post('snooze')
  snooze(@CurrentUser() u: AuthUser, @Body() dto: SnoozeDto) { return this.svc.snooze(this.v(u), dto.key, dto.until, !!dto.remind); }

  @Get('snoozed')
  snoozed(@CurrentUser() u: AuthUser) { return this.svc.snoozedKeys(this.v(u)); }

  /** «+10 мин» к идущей фокус-сессии (п. 5). */
  @Post('sessions/:id/extend')
  async extend(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ExtendDto) {
    const r = await this.db.one<{ id: string }>(
      `UPDATE focus_sessions SET planned_end_at = planned_end_at + make_interval(mins => $4), planned_minutes = planned_minutes + $4
        WHERE tenant_id = $1 AND user_id = $2 AND id = $3 AND status IN ('running','paused') RETURNING id::text`,
      [u.tenantId, u.userId, id, dto.minutes]);
    if (!r) throw AppException.notFound('Фокус уже закончился');
    return { extended: dto.minutes };
  }

  /** После «Готово» (п. 6): плашка результата и следующий шаг. */
  @Post('after-done')
  after(@CurrentUser() u: AuthUser, @Body() dto: AfterDto) { return this.svc.afterDone(this.v(u), dto.taskId ?? null, dto.minutes); }

  // ---------- волна 2 ----------

  /** п. 7: пришло срочное — «Сейчас» и «Предложение ИИ», «Вернуть как было». */
  @Get('replan')
  replan(@CurrentUser() u: AuthUser) { return this.w2.replan(this.v(u)); }

  @Post('replan/accept')
  replanAccept(@CurrentUser() u: AuthUser, @Body() dto: KeyDto) { return this.w2.replanAccept(this.v(u), dto.key); }

  @Post('replan/keep')
  replanKeep(@CurrentUser() u: AuthUser, @Body() dto: KeyDto) { return this.w2.replanKeep(this.v(u), dto.key); }

  @Post('replan/inbox')
  replanInbox(@CurrentUser() u: AuthUser, @Body() dto: KeyDto) { return this.w2.replanInbox(this.v(u), dto.key); }

  @Post('replan/revert')
  replanRevert(@CurrentUser() u: AuthUser) { return this.w2.replanRevert(this.v(u)); }

  /** п. 9: «ждёт вашей проверки» рядом с коллегой. */
  @Get('team-links')
  teamLinks(@CurrentUser() u: AuthUser) { return this.w2.teamLinks(this.v(u)); }

  /** п. 8: договорённости со встреч — только настоящие. */
  @Get('agreements')
  agreements(@CurrentUser() u: AuthUser) { return this.w2.agreements(this.v(u)); }

  @Post('agreements/:id/attach')
  attach(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: AttachDto) { return this.w2.attachAgreement(this.v(u), id, dto.taskId); }

  @Post('agreements/:id/not-promise')
  notPromise(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.w2.notPromise(this.v(u), id); }

  /** п. 10: завершение дня за 2 минуты. */
  @Get('close/summary')
  closeSummary(@CurrentUser() u: AuthUser) { return this.w2.closeSummary(this.v(u)); }

  @Post('close')
  close(@CurrentUser() u: AuthUser, @Body() dto: CloseDto) { return this.w2.close(this.v(u), dto); }

  /** п. 11: первый день за 60 секунд. */
  @Post('first-day')
  firstDay(@CurrentUser() u: AuthUser, @Body() dto: FirstDayDto) { return this.w2.firstDay(this.v(u), dto); }

  @Post('first-day/accept')
  firstDayAccept(@CurrentUser() u: AuthUser, @Body() dto: PlacementsDto) { return this.w2.firstDayAccept(this.v(u), dto.placements); }
}
