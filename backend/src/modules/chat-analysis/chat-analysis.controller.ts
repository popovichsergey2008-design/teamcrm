import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, Max, Min } from 'class-validator';
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
}

class ChatFlagDto {
  @IsBoolean() enabled!: boolean;
}

/** Правка перед заведением: чего не хватило, человек дописывает прямо здесь. */
class ConfirmDto {
  @IsOptional() @IsString() projectId?: string;
  @IsOptional() @IsString() assigneeId?: string;
  @IsOptional() @IsString() @MaxLength(255) title?: string;
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

  /** «Это не задача». Наблюдение остаётся: по отказам видно, где агент ошибается. */
  @Post('actions/:id/reject')
  reject(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.reject(u.tenantId, u.userId, id);
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
