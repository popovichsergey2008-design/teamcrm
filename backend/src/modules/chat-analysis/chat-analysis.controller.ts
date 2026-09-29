import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, MaxLength, Max, Min, ValidateIf } from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { ChatAnalysisService } from './chat-analysis.service';

class SettingsDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  /** Сколько тишины считать концом разговора. */
  @IsOptional() @IsInt() @Min(5) @Max(240) @Type(() => Number) quietMinutes?: number;
  @IsOptional() @IsIn(['suggest', 'auto_high']) mode?: string;
  /** Бот вправе задать уточняющий вопрос прямо в чате. */
  @IsOptional() @IsBoolean() askInChat?: boolean;
  /** Потолок расхода на разбор в месяц, долларов. null — снять потолок. */
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100000) @Type(() => Number)
  monthlyLimitUsd?: number | null;
  /** Суточная сверка: включена, час по поясу организации, сводка руководству. */
  @IsOptional() @IsBoolean() dailyEnabled?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(23) @Type(() => Number) dailyHour?: number;
  @IsOptional() @IsBoolean() dailySummary?: boolean;
}

/** «ИИ определил правильно?» — причины из короткого списка, сервис отбросит чужие. */
class FeedbackDto {
  @IsBoolean() correct!: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) reasons?: string[];
}

class ChatFlagDto {
  @IsBoolean() enabled!: boolean;
}

/** Правка перед заведением: чего не хватило, человек дописывает прямо здесь. */
class ConfirmDto {
  @IsOptional() @IsString() projectId?: string;
  @IsOptional() @IsString() assigneeId?: string;
  // Решение бывает длиннее названия задачи; задаче сервис всё равно обрежет до 255.
  @IsOptional() @IsString() @MaxLength(1000) title?: string;
  /** Для статуса и блокера: задача, куда положить строку, если агент её не нашёл. */
  @IsOptional() @IsString() @MaxLength(20) taskId?: string;
  /** Для встречи: время, которое человек поставил сам, если агент его не узнал. */
  @IsOptional() @IsDateString() startsAt?: string;
}

/**
 * Разбор переписки (ТЗ-12, этап 1).
 *
 * Читать наблюдения может любой сотрудник, но только по тем чатам, которые ему и так
 * видны, — условие стоит в самом запросе. Включать разбор и менять настройки вправе
 * только владелец: это решение об организации, а не о себе.
 */
@ApiTags('chat-analysis')
@ApiBearerAuth()
@Controller('chat-analysis')
export class ChatAnalysisController {
  constructor(private readonly svc: ChatAnalysisService) {}

  @Get('settings')
  settings(@CurrentUser() u: AuthUser) {
    return this.svc.settings(u.tenantId);
  }

  @Patch('settings')
  @Roles('owner')
  save(@CurrentUser() u: AuthUser, @Body() dto: SettingsDto) {
    return this.svc.saveSettings(u.tenantId, dto);
  }

  /** Выключить разбор у одного чата: не всё, что обсуждают, стоит разбирать. */
  @Patch('chats/:id')
  @Roles('owner', 'manager')
  async chatFlag(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ChatFlagDto) {
    await this.svc.setChatAnalysis(u.tenantId, id, dto.enabled);
    return { chatId: id, enabled: dto.enabled };
  }

  /** Что агент понял. На этом этапе — только показ: ничего не создано. */
  @Get('actions')
  actions(
    @CurrentUser() u: AuthUser,
    @Query('chatId') chatId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.actions(u.tenantId, u.userId, {
      chatId: chatId || null,
      limit: limit ? Number(limit) : undefined,
    });
  }

  /**
   * Завести задачу по наблюдению.
   *
   * Единственный путь, которым разбор превращается в задачу: её заводит человек.
   * Постановщиком становится тот, кто поручил в переписке, а не нажавший кнопку.
   */
  @Post('actions/:id/confirm')
  confirm(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ConfirmDto) {
    return this.svc.confirm(u.tenantId, u.userId, id, dto);
  }

  /**
   * Журнал решений: из переписки — по чатам, которые человеку видны, со встреч — всем
   * сотрудникам, как и сами встречи. Заказчику журнал не показываем.
   */
  @Get('decisions')
  @Roles('owner', 'manager', 'member')
  decisions(
    @CurrentUser() u: AuthUser,
    @Query('chatId') chatId?: string,
    @Query('projectId') projectId?: string,
    @Query('all') all?: string,
  ) {
    return this.svc.decisions(u.tenantId, u.userId, {
      chatId: chatId || null, projectId: projectId || null, withRevoked: all === '1',
    });
  }

  /** Снять решение: записано по ошибке или передумали. Строка остаётся с пометкой. */
  @Post('decisions/:id/revoke')
  @Roles('owner', 'manager', 'member')
  revokeDecision(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.revokeDecision(u.tenantId, { userId: u.userId, role: u.role }, id);
  }

  /** «Это не задача». Наблюдение остаётся: по отказам видно, где агент ошибается. */
  @Post('actions/:id/reject')
  reject(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.reject(u.tenantId, u.userId, id);
  }

  /**
   * Отменить задачу, которую агент завёл сам. Сутки, и только тем, кого она касается:
   * постановщику, исполнителю, руководству.
   */
  @Post('actions/:id/undo')
  undo(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.undo(u.tenantId, { userId: u.userId, role: u.role }, id);
  }

  /** «ИИ определил правильно?» — о наблюдении в панели разбора. */
  @Post('actions/:id/feedback')
  feedback(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: FeedbackDto) {
    return this.svc.feedback(u.tenantId, u.userId, id, dto.correct, dto.reasons ?? []);
  }

  /** То же из карточки задачи, заведённой по переписке. Заказчику не показываем. */
  @Post('tasks/:taskId/feedback')
  @Roles('owner', 'manager', 'member')
  feedbackByTask(@CurrentUser() u: AuthUser, @Param('taskId') taskId: string, @Body() dto: FeedbackDto) {
    return this.svc.feedbackByTask(u.tenantId, u.userId, taskId, dto.correct, dto.reasons ?? []);
  }

  /**
   * Примеры для проверки качества (ТЗ разд. 59): рассмотренные людьми наблюдения с
   * сообщениями и вердиктами. Только владельцу и только по видным ему чатам.
   */
  @Get('examples')
  @Roles('owner')
  examples(@CurrentUser() u: AuthUser) {
    return this.svc.examples(u.tenantId, u.userId);
  }

  /** Суточная сверка вручную — чтобы не ждать ночи, проверяя настройку. */
  @Post('daily')
  @Roles('owner')
  async runDaily(@CurrentUser() u: AuthUser) {
    return this.svc.dailyNow(u.tenantId);
  }

  /** Та же отмена из карточки задачи — там, где её видит исполнитель. */
  @Post('tasks/:taskId/undo')
  undoByTask(@CurrentUser() u: AuthUser, @Param('taskId') taskId: string) {
    return this.svc.undoByTask(u.tenantId, { userId: u.userId, role: u.role }, taskId);
  }

  /**
   * Счётчики попадания и расход за месяц. Текстов переписки здесь нет — только цифры,
   * по которым владелец решает, включать ли автосоздание.
   */
  @Get('stats')
  @Roles('owner', 'manager')
  stats(@CurrentUser() u: AuthUser) {
    return this.svc.stats(u.tenantId);
  }

  /** Проходы разбора: по ним видно, что агент работает и на чём спотыкается. */
  @Get('runs')
  @Roles('owner', 'manager')
  runs(@CurrentUser() u: AuthUser, @Query('limit') limit?: string) {
    return this.svc.runs(u.tenantId, u.userId, limit ? Number(limit) : undefined);
  }

  /**
   * Прогнать разбор прямо сейчас, не дожидаясь очередного прохода.
   *
   * Нужно на обкатке: включил, поговорил в чате, подождал тишины — и посмотрел, что
   * агент понял, вместо того чтобы ждать планировщик.
   */
  @Post('run')
  @Roles('owner')
  async run(@CurrentUser() u: AuthUser) {
    return { analyzed: await this.svc.tick(new Date(), u.tenantId) };
  }
}
