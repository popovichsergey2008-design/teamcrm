import {
  Body, Controller, Get, Ip, Param, Post, Query, Req, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import {
  IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min,
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

class CloseDto {
  @IsOptional() @IsInt() @Min(1) @Max(4) csat?: number;
}

class AssignDto {
  /** Кого назначить. Пусто — себя: обычный случай «беру этот разговор». */
  @IsOptional() @IsString() agentId?: string;
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

/**
 * Служба заботы (ТЗ-8).
 *
 * Обращение здесь — разговор, а не заявка: у ручек нет ни «темы», ни «категории»,
 * ни «номера обращения». Человек пишет, что случилось, — остальное система знает
 * сама из контекста.
 *
 * Две стороны у одних и тех же ручек. Клиент работает со СВОИМ обращением; техотдел
 * вендора — с обращениями всех организаций, потому что поддержку продукта ведёт его
 * разработчик. Поэтому перед каждой ручкой с номером разговора спрашиваем
 * `deskTenant`: она отдаёт организацию разговора людям техотдела и собственную —
 * всем остальным, для которых чужого обращения просто не существует.
 *
 * Управляющие ручки (очередь, сводка, известные проблемы, сбой, справочник) проверяют
 * принадлежность к техотделу внутри сервиса: клиенту их не видно вовсе.
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

  /**
   * Очередь дежурного — раньше «:id», иначе слово «queue» примут за номер разговора.
   *
   * Отборы необязательные: пустая строка запроса отдаёт очередь целиком, как раньше.
   * `assigned=me` разбирается на сервере — номер человека знает он, а не браузер.
   */
  @Get('queue')
  queue(
    @CurrentUser() u: AuthUser,
    @Query('skill') skill?: string,
    @Query('priority') priority?: string,
    @Query('org') org?: string,
    @Query('assigned') assigned?: string,
    @Query('waiting') waiting?: string,
  ) {
    return this.desk.queue(u.tenantId, u, {
      skill: skill?.trim() || null,
      priority: priority?.trim() || null,
      orgId: org?.trim() || null,
      assignedTo: assigned === 'me' ? 'me' : null,
      onlyFree: assigned === 'none' ? true : null,
      waitingMinutes: waiting && /^\d+$/.test(waiting) ? Number(waiting) : null,
    });
  }

  /**
   * Эскалации инженера — всё, что ему открыто.
   *
   * Раньше «:id», как и очередь: иначе слово «escalations» примут за номер разговора.
   */
  @Get('escalations')
  escalations(@CurrentUser() u: AuthUser) {
    return this.desk.escalations(u);
  }

  @Get(':id')
  async conversation(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.desk.conversation(await this.desk.deskTenant(u, id), u, id);
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
    @Body() body: { text?: string; conversationId?: string },
  ) {
    if (!file) throw AppException.validation('Файл не приложен');
    return this.desk.attach(
      u.tenantId, u, file, String(body?.text ?? '').slice(0, 8000),
      body?.conversationId ? String(body.conversationId) : null,
    );
  }

  /** «Позвать человека» — доступно всегда, без повторной анкеты. */
  @Post(':id/human')
  async human(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.desk.callHuman(await this.desk.deskTenant(u, id), u, id);
  }

  /** Специалист берёт разговор. */
  @Post(':id/join')
  async join(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.desk.join(await this.desk.deskTenant(u, id), u, id);
  }

  /**
   * Назначить обращение.
   *
   * Себе — любой дежурный, на другого — руководство: перекидывать чужую работу через
   * всю службу не должен тот, кто просто мимо проходил.
   */
  @Post(':id/assign')
  async assign(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: AssignDto) {
    return this.desk.assign(await this.desk.deskTenant(u, id), u, id, dto.agentId ?? null);
  }

  /** Снять с себя: обращение возвращается в очередь и сразу ищет нового исполнителя. */
  @Post(':id/unassign')
  async unassign(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.desk.unassign(await this.desk.deskTenant(u, id), u, id);
  }

  /** Ответ специалиста. */
  @Post(':id/reply')
  async reply(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ReplyDto) {
    return this.desk.reply(await this.desk.deskTenant(u, id), u, id, dto.text);
  }

  /** «Кажется, решено»: разговор ждёт проверки человеком, а не закрывается. */
  @Post(':id/resolve')
  async resolve(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ResolveDto) {
    return this.desk.resolve(await this.desk.deskTenant(u, id), u, id, dto.text);
  }

  /** Слово человека: закрыть с оценкой или вернуть в работу. */
  /** «Вопрос снят»: человек закрывает свой разговор сам, не дожидаясь ответа. */
  @Post(':id/close')
  async close(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: CloseDto) {
    return this.desk.closeByUser(await this.desk.deskTenant(u, id), u, id, dto.csat ?? null);
  }

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
  async engineer(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: EngineerDto) {
    return this.desk.addEngineer(await this.desk.deskTenant(u, id), u, id, dto.userId);
  }

  /** Кому из инженеров открыт разговор и до какого времени. */
  @Get(':id/engineers')
  async engineers(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.desk.grants(await this.desk.deskTenant(u, id), u, id);
  }

  /** Закрыть инженеру доступ: эскалация кончилась — кончается и право читать. */
  @Post(':id/engineer/:engineerId/revoke')
  async revokeEngineer(
    @CurrentUser() u: AuthUser, @Param('id') id: string, @Param('engineerId') engineerId: string,
  ) {
    return this.desk.revokeEngineer(await this.desk.deskTenant(u, id), u, id, engineerId);
  }

  /** Завести баг из разговора: контекст уезжает в задачу сам. */
  @Post(':id/bug')
  async bug(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: BugDto) {
    return this.desk.createBug(await this.desk.deskTenant(u, id), u, id, dto.title);
  }

  /** Созвон из поддержки: комнату создаёт обычный созвон, здесь — пометка о разговоре. */
  @Post(':id/huddle')
  async huddle(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: HuddleDto) {
    return this.desk.startHuddle(await this.desk.deskTenant(u, id), u, id, dto.roomId);
  }

  /** Диагностика для специалиста: контекст, заведённые баги и время ответов. */
  @Get(':id/diagnostics')
  async diagnostics(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.desk.diagnostics(await this.desk.deskTenant(u, id), u, id);
  }

  /**
   * Файл из разговора.
   *
   * Своя ручка, а не общая `/files/:id`: снимок экрана лежит в организации
   * обратившегося, а открыть его должен и он сам, и специалист вендора. Право даёт
   * разговор — чужой файл по этому адресу не достать.
   */
  @Get(':id/files/:fileId')
  async file(
    @CurrentUser() u: AuthUser, @Param('id') id: string,
    @Param('fileId') fileId: string, @Res() res: Response,
  ) {
    const { file, stream } = await this.desk.fileOf(u, id, fileId);
    const inline = file.content_type.startsWith('image/') || file.content_type === 'application/pdf';
    res.setHeader('Content-Type', file.content_type);
    res.setHeader('Content-Length', file.size_bytes);
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(file.file_name)}"`,
    );
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  /*
    Действия с разрешения человека (разд. 38).

    Предложить может специалист, разрешить — только тот, кто обратился. Пока он не
    разрешил, не происходит ничего: в базе лежит предложение с подписью.
  */
  @Post(':id/actions')
  async propose(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ActionDto) {
    return this.desk.proposeAction(await this.desk.deskTenant(u, id), u, id, {
      kind: dto.kind as never, entityId: dto.entityId, value: dto.value ?? null,
    });
  }

  /*
    Решение человека по действию — с подписью.

    Адрес и устройство берём именно здесь: значим момент СОГЛАСИЯ. Это та запись,
    которую придётся однажды показать, объясняя, почему в чужой задаче поменялся срок.
  */
  @Post(':id/actions/:actionId')
  async decide(
    @CurrentUser() u: AuthUser, @Param('id') id: string,
    @Param('actionId') actionId: string, @Body() dto: DecideActionDto,
    @Ip() ip: string, @Req() req: Request,
  ) {
    return this.desk.decideAction(
      await this.desk.deskTenant(u, id), u, id, actionId, dto.allow,
      { ip, userAgent: String(req.headers['user-agent'] ?? '') },
    );
  }

  /** Вернуть как было — там, где это осмысленно. */
  @Post(':id/actions/:actionId/undo')
  async undo(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('actionId') actionId: string) {
    return this.desk.undoAction(await this.desk.deskTenant(u, id), u, id, actionId);
  }

  /**
   * Вернуть помощника в разговор.
   *
   * Только явным решением специалиста: после подключения человека бот по умолчанию
   * остаётся копилотом, и «сам вернулся» посреди живого разговора — худшее, что он
   * может сделать.
   */
  @Post(':id/ai/return')
  async returnAi(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.desk.returnAi(await this.desk.deskTenant(u, id), u, id);
  }

  /** Копилот дежурного: суть, что проверить, что сказать человеку. */
  @Post(':id/copilot')
  async copilot(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.desk.copilot(await this.desk.deskTenant(u, id), u, id);
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

  /** Что знает помощник: разделы справочника и дата загрузки (техотделу). */
  @Get('handbook/state')
  handbook(@CurrentUser() u: AuthUser) {
    return this.desk.handbookState(u.tenantId, u);
  }

  /** Обновить справочник во всех организациях — право техотдела. */
  @Post('handbook/load')
  loadHandbook(@CurrentUser() u: AuthUser) {
    return this.desk.loadHandbook(u.tenantId, u);
  }
}
