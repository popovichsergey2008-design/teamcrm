import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { CaldavService } from './caldav.service';
import { CalendarPlusService } from './calendar-plus.service';
import { ChatMeetingService } from './chat-meeting.service';
import { MeetingPrepService } from './meeting-prep.service';
import { TimeWorkService } from './time-work.service';
import { AgentService, PlanItem } from './agent.service';

class PrefsDto {
  @IsOptional() @IsString() @MaxLength(5) workStart?: string | null;
  @IsOptional() @IsString() @MaxLength(5) workEnd?: string | null;
  @IsOptional() @IsString() @MaxLength(5) lunchStart?: string | null;
  @IsOptional() @IsString() @MaxLength(5) lunchEnd?: string | null;
  @IsOptional() @IsString() @MaxLength(64) timeZone?: string;
  @IsOptional() @IsInt() @Min(0) @Max(2400) focusGoalMin?: number;
  @IsOptional() @IsBoolean() chatSuggest?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(120) prepMin?: number;
  @IsOptional() @IsBoolean() onboarded?: boolean;
}
class BestTimeDto {
  @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) participantIds!: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) optionalIds?: string[];
  @IsInt() @Min(5) @Max(480) minutes!: number;
  @IsOptional() @IsString() exceptEventId?: string;
  @IsOptional() @IsDateString() notBefore?: string;
  @IsOptional() @IsDateString() notAfter?: string;
  @IsOptional() @IsInt() @Min(1) @Max(21) days?: number;
}
class PhraseDto {
  @IsString() @MinLength(3) @MaxLength(500) text!: string;
  @IsOptional() @IsString() @MaxLength(20) now?: string;
  @IsOptional() @IsNumber() offset?: number;
}
class CreateDto {
  @IsString() @MinLength(1) @MaxLength(255) title!: string;
  @IsDateString() startsAt!: string;
  @IsDateString() endsAt!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) participantIds?: string[];
  @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @IsOptional() @IsIn(['daily', 'weekdays', 'weekly', 'biweekly', 'monthly']) repeat?: 'daily' | 'weekdays' | 'weekly' | 'biweekly' | 'monthly';
  @IsIn(['phrase', 'find_time', 'chat', 'agent', 'assistant']) via!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(5) @IsString({ each: true }) agendaTaskIds?: string[];
  @IsOptional() @IsBoolean() allDay?: boolean;
  @IsOptional() @IsString() @MaxLength(255) location?: string;
}
class KeyDto {
  @IsString() @MaxLength(200) key!: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}
class AgendaDto {
  @IsString() @MinLength(1) @MaxLength(4000) body!: string;
}
class YandexDto {
  @IsString() @MinLength(3) @MaxLength(255) login!: string;
  @IsString() @MinLength(4) @MaxLength(255) password!: string;
}
class ProposeDto {
  @IsString() chatId!: string;
  @IsOptional() @IsString() @MaxLength(500) text?: string;
}
class VoteDto {
  @IsInt() @Min(0) @Max(5) index!: number;
}
class RangeDto {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}
class PlacementDto {
  @IsString() taskId!: string;
  @IsDateString() startsAt!: string;
  @IsDateString() endsAt!: string;
}
class ApplyWeekDto {
  @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => PlacementDto) placements!: PlacementDto[];
}
class MergeDto {
  @IsString() taskId!: string;
}
class DeclineDto {
  @IsOptional() @IsString() @MaxLength(300) comment?: string;
}
class AgentDto {
  @IsString() @MinLength(3) @MaxLength(500) text!: string;
  /** #4920: прошлые команды разговора — «а во вторник?» продолжает прошлый поиск. */
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) @MaxLength(500, { each: true }) history?: string[];
}
class AgentApplyDto {
  @IsArray() @ArrayMaxSize(20) items!: PlanItem[];
  @IsOptional() @IsString() @MaxLength(500) message?: string | null;
}
class ShortenDto {
  @IsString() eventId!: string;
  @IsInt() @Min(10) @Max(240) minutes!: number;
}
class SlotDto {
  @IsDateString() startsAt!: string;
  @IsDateString() endsAt!: string;
}

/** Календарь #4892: ассистент, лучшее время, событие фразой, подготовка, встреча из чата, Яндекс. */
@ApiTags('calendar')
@ApiBearerAuth()
@Controller('calendar/plus')
@Roles('owner', 'manager', 'member')
export class CalendarPlusController {
  constructor(
    private readonly plus: CalendarPlusService,
    private readonly prep: MeetingPrepService,
    private readonly chat: ChatMeetingService,
    private readonly caldav: CaldavService,
    private readonly work: TimeWorkService,
    private readonly agent: AgentService,
  ) {}

  /** ИИ-агент календаря (п. 13): план изменений — и «Применить». */
  @Post('agent')
  agentPlan(@CurrentUser() u: AuthUser, @Body() dto: AgentDto) { return this.agent.plan(u.tenantId, u, dto.text, dto.history ?? []); }

  @Post('agent/apply')
  agentApply(@CurrentUser() u: AuthUser, @Body() dto: AgentApplyDto) { return this.agent.apply(u.tenantId, u, dto); }

  /** Аналитика времени (п. 12): «Моя неделя» и «Команда» для руководителя. */
  @Get('analytics/me')
  myWeek(@CurrentUser() u: AuthUser, @Query('from') from?: string, @Query('to') to?: string) { return this.agent.myWeek(u.tenantId, u, { from, to }); }

  @Get('analytics/team')
  teamWeek(@CurrentUser() u: AuthUser, @Query('from') from?: string, @Query('to') to?: string) { return this.agent.team(u.tenantId, u, { from, to }); }

  @Post('analytics/shorten')
  shorten(@CurrentUser() u: AuthUser, @Body() dto: ShortenDto) { return this.agent.shorten(u.tenantId, u, dto.eventId, dto.minutes); }

  @Get('prefs')
  prefs(@CurrentUser() u: AuthUser) { return this.plus.prefs(u.tenantId, u.userId); }

  @Patch('prefs')
  savePrefs(@CurrentUser() u: AuthUser, @Body() dto: PrefsDto) { return this.plus.savePrefs(u.tenantId, u.userId, dto); }

  /** Карточка недели и подсказки ассистента (п. 1–2, 10). */
  @Get('assistant')
  async assistant(@CurrentUser() u: AuthUser, @Query('from') from?: string, @Query('to') to?: string) {
    const base = await this.plus.assistant(u.tenantId, u, { from, to });
    const prefs = await this.plus.prefsRow(u.tenantId, u.userId);
    const f = from ?? new Date().toISOString();
    const t = to ?? new Date(Date.now() + 7 * 86_400_000).toISOString();
    const declined = await this.work.declinedSuggestions(u.tenantId, u, f, t, prefs?.dismissed ?? []).catch(() => []);
    const overlap = base.suggestions.filter((s) => s.kind === 'overlap');
    const rest = base.suggestions.filter((s) => s.kind !== 'overlap');
    return { ...base, suggestions: [...overlap, ...declined, ...rest].slice(0, 4) };
  }

  @Post('assistant/apply')
  apply(@CurrentUser() u: AuthUser, @Body() dto: KeyDto) {
    if (dto.key.startsWith('declined:')) return this.work.applyDeclined(u.tenantId, u, dto.key);
    return this.plus.applySuggestion(u.tenantId, u, dto);
  }

  /** «Разложить по неделе» (п. 8): предпросмотр и «Применить». */
  @Post('plan-week')
  planWeek(@CurrentUser() u: AuthUser, @Body() dto: RangeDto) { return this.work.planWeekPreview(u.tenantId, u, dto); }

  @Post('plan-week/apply')
  planWeekApply(@CurrentUser() u: AuthUser, @Body() dto: ApplyWeekDto) { return this.work.planWeekApply(u.tenantId, u, dto.placements); }

  /** Цель фокуса на неделю (п. 9). */
  @Post('focus-goal')
  focusGoal(@CurrentUser() u: AuthUser, @Body() dto: RangeDto) { return this.work.focusGoal(u.tenantId, u, dto); }

  @Post('focus-goal/apply')
  focusGoalApply(@CurrentUser() u: AuthUser, @Body() dto: RangeDto) { return this.work.focusGoalApply(u.tenantId, u, dto); }

  /** После встречи (п. 7). */
  @Post('meetings/:id/to-chat')
  toChat(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.work.summaryToChat(u.tenantId, u, id); }

  @Post('meetings/:id/next-week')
  nextWeek(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.work.nextWeek(u.tenantId, u, id); }

  @Post('drafts/:id/merge')
  merge(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: MergeDto) { return this.work.mergeDraft(u.tenantId, u, id, dto.taskId); }

  @Get('summaries')
  summaries(@CurrentUser() u: AuthUser, @Query('from') from: string, @Query('to') to: string) {
    return this.work.summaries(u.tenantId, u.userId, from, to);
  }

  /** Отказ с причиной и перенос в 1 клик (п. 10). */
  @Post('events/:id/decline')
  decline(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: DeclineDto) { return this.work.decline(u.tenantId, u.userId, id, dto.comment ?? null); }

  @Get('events/:id/declines')
  declines(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.work.declines(u.tenantId, u, id); }

  @Post('events/:id/reschedule')
  reschedule(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: SlotDto) {
    return this.work.reschedule(u.tenantId, u, id, dto.startsAt, dto.endsAt);
  }

  @Post('assistant/dismiss')
  dismiss(@CurrentUser() u: AuthUser, @Body() dto: KeyDto) { return this.plus.dismiss(u.tenantId, u.userId, dto.key); }

  /** «Найти время» с причинами (п. 4). */
  @Post('best-time')
  bestTime(@CurrentUser() u: AuthUser, @Body() dto: BestTimeDto) { return this.plus.bestTime(u.tenantId, u, dto); }

  /** Событие одной фразой: предпросмотр (п. 3). */
  @Post('phrase')
  phrase(@CurrentUser() u: AuthUser, @Body() dto: PhraseDto) { return this.plus.phrasePreview(u.tenantId, u, dto); }

  @Post('events')
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateDto) { return this.plus.createEvent(u.tenantId, u, dto); }

  /** Созвоны QEVO, в том числе начатые из чата (п. 0). */
  @Get('calls')
  calls(@CurrentUser() u: AuthUser, @Query('from') from: string, @Query('to') to: string) {
    return this.plus.calls(u.tenantId, u.userId, from, to);
  }

  /** #4920, п. 4: карточка созвона — итоги, задачи, прошлые договорённости, вход в звонок. */
  @Get('calls/:id/card')
  callCard(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.plus.callCard(u.tenantId, u.userId, id);
  }

  /** Карточка встречи = подготовка (п. 6). */
  @Get('events/:id/prep')
  prepCard(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.prep.card(u.tenantId, u, id); }

  @Post('events/:id/agenda/generate')
  genAgenda(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('save') save?: string) {
    return this.prep.generate(u.tenantId, u, id, save === '1');
  }

  @Put('events/:id/agenda')
  saveAgenda(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: AgendaDto) { return this.prep.saveAgenda(u.tenantId, u, id, dto.body); }

  @Post('events/:id/agenda/send')
  sendAgenda(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.prep.sendAgenda(u.tenantId, u, id); }

  /** Встреча из чата (п. 5). */
  @Post('proposals')
  propose(@CurrentUser() u: AuthUser, @Body() dto: ProposeDto) {
    return this.chat.propose(u.tenantId, dto.chatId, u.userId, dto.text ?? '/встреча', null, null);
  }

  @Get('proposals/:id')
  proposal(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.chat.view(u.tenantId, u.userId, id); }

  @Post('proposals/:id/vote')
  vote(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: VoteDto) { return this.chat.vote(u.tenantId, u.userId, id, dto.index); }

  @Post('proposals/:id/schedule')
  schedule(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: VoteDto) { return this.chat.schedule(u.tenantId, u.userId, id, dto.index); }

  @Post('proposals/mute')
  mute(@CurrentUser() u: AuthUser, @Body() dto: ProposeDto) { return this.chat.mute(u.tenantId, u.userId, dto.chatId); }

  /** Яндекс Календарь по CalDAV (п. 1). */
  @Get('yandex')
  yandex(@CurrentUser() u: AuthUser) { return this.caldav.status(u.userId); }

  @Post('yandex')
  connectYandex(@CurrentUser() u: AuthUser, @Body() dto: YandexDto) { return this.caldav.connect(u.tenantId, u.userId, dto.login, dto.password); }

  @Post('yandex/sync')
  syncYandex(@CurrentUser() u: AuthUser) { return this.caldav.syncNow(u.userId); }

  @Delete('yandex')
  disconnectYandex(@CurrentUser() u: AuthUser) { return this.caldav.disconnect(u.tenantId, u.userId); }
}
