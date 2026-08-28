import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AssistantService } from './assistant.service';
import { AskService } from './ask.service';
import { EveningService } from './evening.service';
import { GapsService } from './gaps.service';
import { MaintenanceService } from './maintenance.service';
import { ModeratorService } from './moderator.service';

class ModeDto {
  @IsString() @IsIn(['off', 'copilot', 'autopilot']) mode!: string;
}

class AutoTasksDto {
  @IsBoolean() enabled!: boolean;
}

class EnabledDto {
  @IsBoolean() enabled!: boolean;
}

class GapApplyDto {
  @IsString() @MaxLength(32) taskId!: string;
  @IsOptional() @IsString() @MaxLength(32) assigneeId?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Срок в формате ГГГГ-ММ-ДД' }) deadline?: string;
  /** Человек перегружен, и руководитель это видит и всё равно назначает. */
  @IsOptional() @IsBoolean() confirmOverload?: boolean;
}

class AskDto {
  @IsString() @MaxLength(300) question!: string;
}

class GapSkipDto {
  @IsString() @MaxLength(32) taskId!: string;
  @IsIn(['assignee', 'deadline']) kind!: 'assignee' | 'deadline';
}

/**
 * Смарт-пинги ассистента.
 *
 * Режим читают все — человек вправе знать, сам ассистент ему пишет или с чьего-то
 * ведома. Меняет владелец: это решение о том, как компания разговаривает с людьми.
 */
@ApiTags('assistant')
@ApiBearerAuth()
@Controller('assistant')
@Roles('owner', 'manager', 'member')
export class AssistantController {
  constructor(
    private readonly assistant: AssistantService,
    private readonly moderator: ModeratorService,
    private readonly maintenance: MaintenanceService,
    private readonly gaps: GapsService,
    private readonly evening: EveningService,
    private readonly ask: AskService,
  ) {}

  @Get('mode')
  mode(@CurrentUser() u: AuthUser) {
    return this.assistant.mode(u.tenantId);
  }

  @Put('mode')
  setMode(@CurrentUser() u: AuthUser, @Body() dto: ModeDto) {
    return this.assistant.setMode(u.tenantId, u.role, dto.mode);
  }

  /** Что ассистент напомнил лично мне. */
  @Get('pings')
  pings(@CurrentUser() u: AuthUser) {
    return this.assistant.listForUser(u.tenantId, u.userId);
  }

  /** Что он предлагает разослать по моим задачам (режим «копилот»). */
  @Get('pings/proposed')
  proposed(@CurrentUser() u: AuthUser) {
    return this.assistant.listProposed(u.tenantId, u.userId);
  }

  @Post('pings/:id/send')
  send(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.assistant.send(u.tenantId, u.userId, id);
  }

  /** Создавать ли задачи со встречи сразу. */
  @Put('meeting-tasks')
  setAutoTasks(@CurrentUser() u: AuthUser, @Body() dto: AutoTasksDto) {
    return this.assistant.setAutoTasks(u.tenantId, u.role, dto.enabled);
  }

  // ---------- уборка брошенного ----------

  /**
   * Что ассистент предлагает прибрать и что недавно прибрали.
   *
   * Читают все: список показывает, что происходит с доской. Решают — владелец
   * и руководитель, это проверяется в сервисе.
   */
  @Get('maintenance')
  maintenanceList(@CurrentUser() u: AuthUser) {
    return this.maintenance.list(u.tenantId);
  }

  @Put('maintenance-enabled')
  setMaintenance(@CurrentUser() u: AuthUser, @Body() dto: EnabledDto) {
    return this.maintenance.setEnabled(u.tenantId, u.role, dto.enabled);
  }

  @Post('maintenance/:id/apply')
  applyMaintenance(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.maintenance.apply(u.tenantId, u, id);
  }

  @Post('maintenance/:id/dismiss')
  dismissMaintenance(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.maintenance.dismiss(u.tenantId, u, id);
  }

  /** Вернуть как было. Ради этой кнопки уборка вообще возможна. */
  @Post('maintenance/:id/undo')
  undoMaintenance(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.maintenance.undo(u.tenantId, u, id);
  }

  /** Мои ближайшие повестки — то, что начинается в пределах получаса. */
  @Get('agendas')
  agendas(@CurrentUser() u: AuthUser) {
    return this.moderator.upcoming(u.tenantId, u.userId);
  }

  @Get('agendas/:eventId')
  agenda(@CurrentUser() u: AuthUser, @Param('eventId') eventId: string) {
    return this.moderator.agenda(u.tenantId, eventId);
  }

  /** Отклик секретаря: доля напоминаний, после которых человек взялся за дело. */
  @Get('reaction')
  reaction(@CurrentUser() u: AuthUser) {
    return this.assistant.reaction(u.tenantId);
  }

  /** «Сделаю сегодня» — ответ делом; именно он и считается откликом. */
  @Post('pings/:id/acted')
  acted(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.assistant.acted(u.tenantId, u.userId, id);
  }

  @Post('pings/:id/dismiss')
  dismiss(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.assistant.dismiss(u.tenantId, u.userId, id);
  }

  /**
   * Дыры в данных: задачи без исполнителя и без срока — с готовыми предложениями.
   *
   * Смотреть может любой сотрудник (это состояние его же работы), а заполнять —
   * руководитель: раздача задач и сроков решается не тем, кто их выполняет.
   */
  @Get('gaps')
  listGaps(@CurrentUser() u: AuthUser) {
    return this.gaps.list(u.tenantId);
  }

  @Post('gaps/apply')
  applyGap(@CurrentUser() u: AuthUser, @Body() dto: GapApplyDto) {
    return this.gaps.apply(u.tenantId, u.userId, u.role, dto);
  }

  /**
   * Спросить о делах обычным языком: «что с проектом Сайт», «кто свободен», «что горит».
   *
   * Отвечаем цифрами из базы, а не моделью: такие вопросы про сейчас, и придуманный
   * ответ здесь опаснее отсутствия ответа.
   */
  @Post('ask')
  askAssistant(@CurrentUser() u: AuthUser, @Body() dto: AskDto) {
    return this.ask.ask(u.tenantId, u.userId, dto.question);
  }

  /** Итоги дня прямо сейчас: то же, что придёт вечером, но по требованию. */
  @Get('evening/preview')
  eveningPreview(@CurrentUser() u: AuthUser) {
    // Пояс берём из профиля внутри сервиса: в токене его нет, а «сегодня»
    // у людей в разных поясах разное.
    return this.evening.preview(u.tenantId, null);
  }

  @Post('gaps/skip')
  skipGap(@CurrentUser() u: AuthUser, @Body() dto: GapSkipDto) {
    return this.gaps.skip(u.tenantId, u.userId, u.role, dto.taskId, dto.kind);
  }
}
