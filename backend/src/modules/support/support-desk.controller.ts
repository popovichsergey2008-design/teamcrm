import {
  Body, Controller, Get, Param, Post, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import {
  IsArray, IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min,
} from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { SupportDeskService } from './support-desk.service';

/**
 * Технический контекст обращения.
 *
 * Поля перечислены поимённо и намеренно: это разрешённый список (ТЗ-8, разд. 15–16).
 * Всё, чего здесь нет, до сервера не доедет — ни токены, ни буфер обмена, ни чужие
 * данные. Запрет, который проверяется схемой, надёжнее запрета в договорённостях.
 */
class ContextDto {
  @IsOptional() @IsString() @MaxLength(500) url?: string;
  @IsOptional() @IsString() @MaxLength(120) route?: string;
  @IsOptional() @IsString() @MaxLength(32) entityType?: string;
  @IsOptional() @IsString() @MaxLength(64) entityId?: string;
  @IsOptional() @IsString() @MaxLength(120) browser?: string;
  @IsOptional() @IsString() @MaxLength(80) os?: string;
  @IsOptional() @IsString() @MaxLength(40) appVersion?: string;
  @IsOptional() @IsString() @MaxLength(64) buildId?: string;
  @IsOptional() @IsString() @MaxLength(1000) lastError?: string;
  @IsOptional() @IsString() @MaxLength(64) requestId?: string;
  @IsOptional() @IsString() @MaxLength(24) network?: string;
}

class SendDto {
  @IsOptional() @IsString() @MaxLength(8000) text?: string;
  @IsOptional() context?: ContextDto;
}

class ReplyDto {
  @IsString() @MaxLength(8000) text!: string;
}

class ResolveDto {
  @IsOptional() @IsString() @MaxLength(8000) text?: string;
}

class ConfirmDto {
  @IsBoolean() ok!: boolean;
  /** Оценка: 1 — «плохо», 4 — «отлично» (разд. 31). */
  @IsOptional() @IsInt() @Min(1) @Max(4) csat?: number;
  @IsOptional() @IsString() @MaxLength(64) reason?: string;
}

class ReopenDto {
  @IsOptional() @IsString() @MaxLength(8000) text?: string;
}

class EngineerDto {
  @IsString() userId!: string;
}

class BugDto {
  @IsOptional() @IsString() @MaxLength(200) title?: string;
}

class HuddleDto {
  @IsString() @MaxLength(64) roomId!: string;
}

class ActionDto {
  @IsString() @MaxLength(32) kind!: string;
  @IsString() @MaxLength(32) entityId!: string;
  @IsOptional() @IsString() @MaxLength(64) value?: string | null;
}

class DecideActionDto {
  @IsBoolean() allow!: boolean;
}

class KnownIssueDto {
  @IsString() @MaxLength(32) taskId!: string;
  @IsString() @MaxLength(200) title!: string;
  /** Слова-приметы через запятую: по ним проблему узнают в чужом обращении. */
  @IsOptional() @IsString() @MaxLength(500) pattern?: string;
}

class KnownIssueActiveDto {
  @IsBoolean() active!: boolean;
}

class IncidentDto {
  @IsString() @MaxLength(200) title!: string;
  @IsString() @MaxLength(4000) message!: string;
}

class AgentDto {
  @IsString() userId!: string;
  @IsBoolean() active!: boolean;
  @IsOptional() @IsArray() @IsString({ each: true }) skills?: string[];
}

/**
 * Служба заботы (ТЗ-8).
 *
 * Обращение здесь — разговор, а не заявка: у ручек нет ни «темы», ни «категории»,
 * ни «номера обращения». Человек пишет, что случилось, — остальное система знает
 * сама из контекста.
 */
@ApiTags('support-desk')
@ApiBearerAuth()
@Controller('support/desk')
@Roles('owner', 'manager', 'member') // у клиента свой портал, в поддержку компании он не пишет
export class SupportDeskController {
  constructor(private readonly desk: SupportDeskService) {}

  /** Что показать в панели: живой разговор, история, дежурные, честное время ответа. */
  @Get()
  overview(@CurrentUser() u: AuthUser) {
    return this.desk.desk(u.tenantId, u);
  }

  /** Сводка службы заботы для руководителя — тоже раньше «:id». */
  @Get('dashboard')
  dashboard(@CurrentUser() u: AuthUser) {
    return this.desk.dashboard(u.tenantId, u);
  }

  /** Очередь дежурного — раньше «:id», иначе слово «queue» примут за номер разговора. */
  @Get('queue')
  queue(@CurrentUser() u: AuthUser) {
    return this.desk.queue(u.tenantId, u);
  }

  @Get(':id')
  conversation(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.desk.conversation(u.tenantId, u, id);
  }

  /** Написать в поддержку. Разговор заводится сам — анкеты здесь нет. */
  @Post('messages')
  send(@CurrentUser() u: AuthUser, @Body() dto: SendDto) {
    return this.desk.send(u.tenantId, u, dto.text ?? '', dto.context ?? null);
  }

  /** Снимок экрана или файл: их присылают вместо тысячи слов. */
  @Post('messages/file')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  attach(
    @CurrentUser() u: AuthUser,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { text?: string },
  ) {
    if (!file) throw AppException.validation('Файл не приложен');
    return this.desk.attach(u.tenantId, u, file, String(body?.text ?? '').slice(0, 8000));
  }

  /** «Позвать человека» — доступно всегда, без повторной анкеты. */
  @Post(':id/human')
  human(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.desk.callHuman(u.tenantId, u, id);
  }

  /** Специалист берёт разговор. */
  @Post(':id/join')
  join(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.desk.join(u.tenantId, u, id);
  }

  /** Ответ специалиста. */
  @Post(':id/reply')
  reply(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ReplyDto) {
    return this.desk.reply(u.tenantId, u, id, dto.text);
  }

  /** «Кажется, решено»: разговор ждёт проверки человеком, а не закрывается. */
  @Post(':id/resolve')
  resolve(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ResolveDto) {
    return this.desk.resolve(u.tenantId, u, id, dto.text);
  }

  /** Слово человека: закрыть с оценкой или вернуть в работу. */
  @Post(':id/confirm')
  confirm(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ConfirmDto) {
    return this.desk.confirm(u.tenantId, u, id, dto.ok, dto.csat ?? null, dto.reason ?? null);
  }

  /** «Эта проблема снова появилась» — со всем прошлым контекстом. */
  @Post(':id/reopen')
  reopen(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ReopenDto) {
    return this.desk.reopen(u.tenantId, u, id, dto.text);
  }

  /** Подключить инженера: он приходит в тот же разговор и видит его целиком. */
  @Post(':id/engineer')
  engineer(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: EngineerDto) {
    return this.desk.addEngineer(u.tenantId, u, id, dto.userId);
  }

  /** Завести баг из разговора: контекст уезжает в задачу сам. */
  @Post(':id/bug')
  bug(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: BugDto) {
    return this.desk.createBug(u.tenantId, u, id, dto.title);
  }

  /** Созвон из поддержки: комнату создаёт обычный созвон, здесь — пометка о разговоре. */
  @Post(':id/huddle')
  huddle(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: HuddleDto) {
    return this.desk.startHuddle(u.tenantId, u, id, dto.roomId);
  }

  /** Диагностика для специалиста: контекст, заведённые баги и время ответов. */
  @Get(':id/diagnostics')
  diagnostics(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.desk.diagnostics(u.tenantId, u, id);
  }

  /*
    Действия с разрешения человека (разд. 38).

    Предложить может специалист, разрешить — только тот, кто обратился. Пока он не
    разрешил, не происходит ничего: в базе лежит предложение с подписью.
  */
  @Post(':id/actions')
  propose(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ActionDto) {
    return this.desk.proposeAction(u.tenantId, u, id, {
      kind: dto.kind as never, entityId: dto.entityId, value: dto.value ?? null,
    });
  }

  @Post(':id/actions/:actionId')
  decide(
    @CurrentUser() u: AuthUser, @Param('id') id: string,
    @Param('actionId') actionId: string, @Body() dto: DecideActionDto,
  ) {
    return this.desk.decideAction(u.tenantId, u, id, actionId, dto.allow);
  }

  /** Вернуть как было — там, где это осмысленно. */
  @Post(':id/actions/:actionId/undo')
  undo(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('actionId') actionId: string) {
    return this.desk.undoAction(u.tenantId, u, id, actionId);
  }

  /** Копилот дежурного: суть, что проверить, что сказать человеку. */
  @Post(':id/copilot')
  copilot(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.desk.copilot(u.tenantId, u, id);
  }

  /** Известные проблемы: список, пометка задачи, включение и выключение. */
  @Get('known/list')
  knownIssues(@CurrentUser() u: AuthUser) {
    return this.desk.knownIssues(u.tenantId, u);
  }

  @Post('known')
  addKnown(@CurrentUser() u: AuthUser, @Body() dto: KnownIssueDto) {
    return this.desk.addKnownIssue(u.tenantId, u, dto.taskId, dto.title, dto.pattern ?? dto.title);
  }

  @Post('known/:knownId')
  setKnownActive(@CurrentUser() u: AuthUser, @Param('knownId') knownId: string, @Body() dto: KnownIssueActiveDto) {
    return this.desk.setKnownIssueActive(u.tenantId, u, knownId, dto.active);
  }

  /** Массовый сбой: объявить и закрыть. Одно честное сообщение вместо двадцати разговоров. */
  @Post('incident')
  declareIncident(@CurrentUser() u: AuthUser, @Body() dto: IncidentDto) {
    return this.desk.declareIncident(u.tenantId, u, dto.title, dto.message);
  }

  @Post('incident/:incidentId/resolve')
  resolveIncident(@CurrentUser() u: AuthUser, @Param('incidentId') incidentId: string) {
    return this.desk.resolveIncident(u.tenantId, u, incidentId);
  }

  /** Кто дежурит. */
  @Get('team/list')
  team(@CurrentUser() u: AuthUser) {
    return this.desk.team(u.tenantId);
  }

  /** Назначить или снять дежурного — право руководства. */
  @Post('team')
  @Roles('owner', 'manager')
  setAgent(@CurrentUser() u: AuthUser, @Body() dto: AgentDto) {
    return this.desk.setAgent(u.tenantId, u, dto.userId, dto.active, dto.skills ?? []);
  }
}
