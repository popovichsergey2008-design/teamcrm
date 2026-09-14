import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UploadedFile, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FileFieldsInterceptor, FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsDateString, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { ChatsService } from './chats.service';

class OpenDmDto {
  @IsString() userId!: string;
}
class CreateGroupDto {
  @IsString() @MaxLength(160) title!: string;
  @IsOptional() @IsArray() @IsString({ each: true }) userIds?: string[];
}
class SendDto {
  @IsOptional() @IsString() @MaxLength(8000) body?: string;
  /** Кого позвали по «@»: id, а не имена — имена переименовываются. */
  @IsOptional() @IsArray() @IsString({ each: true }) mentionIds?: string[];
  /** Ответ в ветке этого сообщения: в общей ленте его не будет. */
  @IsOptional() @IsString() @MaxLength(32) threadRootId?: string;
  /** «Также отправить в основной чат» — когда ответ важен не только участникам ветки. */
  @IsOptional() @IsBoolean() alsoInChannel?: boolean;
}
class AskAiDto {
  @IsString() @MaxLength(2000) question!: string;
}
class AiSearchDto {
  @IsString() @MaxLength(500) query!: string;
}
class RemindDto {
  /** Момент считает клиент: он знает часовой пояс и что такое «сегодня вечером». */
  @IsString() remindAt!: string;
}
class ReactionDto {
  @IsString() @MaxLength(16) emoji!: string;
}
class PinDto {
  @IsOptional() @IsBoolean() pinned?: boolean;
}
class CreateChannelDto {
  @IsString() @MaxLength(160) title!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  /** Умолчание — приватный: раскрыть канал проще, чем спрятать уже сказанное. */
  @IsOptional() @IsBoolean() isPrivate?: boolean;
  @IsOptional() @IsArray() @IsString({ each: true }) userIds?: string[];
}
class CreateExternalDto {
  @IsString() @MaxLength(160) title!: string;
  @IsOptional() @IsString() clientId?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) userIds?: string[];
}
class AddMembersDto {
  @IsArray() @IsString({ each: true }) userIds!: string[];
}
class ScheduleDto {
  @IsString() @MinLength(1) @MaxLength(8000) body!: string;
  /** Время отправки в ISO: считает клиент — он знает часовой пояс человека. */
  @IsDateString() sendAt!: string;
  /** none — один раз, daily — каждый день в это же время. */
  @IsOptional() @IsIn(['none', 'daily']) repeat?: string;
  @IsOptional() @IsString() rootId?: string;
  @IsOptional() @IsBoolean() alsoInChannel?: boolean;
  @IsOptional() @IsArray() @IsString({ each: true }) mentionIds?: string[];
}

class RescheduleDto {
  /** Либо переносим время, либо правим текст — до отправки это ещё черновик. */
  @IsOptional() @IsDateString() sendAt?: string;
  @IsOptional() @IsString() @MaxLength(8000) body?: string;
}

class MessageEditDto {
  @IsString() @MaxLength(4000) body!: string;
}

class RenameDto {
  @IsString() @MaxLength(160) title!: string;
}
class MemberRoleDto {
  @IsIn(['admin', 'member']) role!: 'admin' | 'member';
}
class DescriptionDto {
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
}

/** Мессенджер команды. Роль client сюда не допускается — у заказчика свой портал. */
@ApiTags('chats')
@ApiBearerAuth()
@Controller('chats')
@Roles('owner', 'manager', 'member')
export class ChatsController {
  constructor(private readonly chats: ChatsService) {}

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.chats.list(u.tenantId, u.userId);
  }

  /** Открыть личный диалог (создаётся при первом обращении). */
  @Post('dm')
  openDm(@CurrentUser() u: AuthUser, @Body() dto: OpenDmDto) {
    return this.chats.openDm(u.tenantId, u.userId, dto.userId);
  }

  @Post('groups')
  createGroup(@CurrentUser() u: AuthUser, @Body() dto: CreateGroupDto) {
    return this.chats.createGroup(u.tenantId, u.userId, dto.title, dto.userIds ?? []);
  }

  /** Чат доски проекта — обсуждение рядом с задачами, а не в отдельном мессенджере. */
  @Post('project/:projectId')
  openProject(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string) {
    return this.chats.openProjectChat(u.tenantId, u.userId, u.role, projectId);
  }

  /**
   * Разделы «Треды», «Сохранённое», «Упоминания» и «Входящие».
   *
   * Стоят ВЫШЕ маршрутов с «:id»: иначе `/chats/threads` разберётся как чат
   * с идентификатором «threads».
   */
  @Get('threads')
  myThreads(@CurrentUser() u: AuthUser) {
    return this.chats.myThreads(u.tenantId, u);
  }

  /** Канал — общая тема: публичный виден всем, приватный как группа с названием темы. */
  @Post('channels')
  createChannel(@CurrentUser() u: AuthUser, @Body() dto: CreateChannelDto) {
    return this.chats.createChannel(u.tenantId, u, dto);
  }

  /** Витрина «Все каналы»: публичные каналы компании. Приватных здесь нет вовсе. */
  @Get('channels')
  channels(@CurrentUser() u: AuthUser) {
    return this.chats.channels(u.tenantId, u);
  }

  /**
   * «Что я пропустил»: сводка непрочитанного по всем доступным чатам.
   *
   * Стоит выше маршрутов с «:id» — иначе `/chats/ai` разберётся как чат с таким id.
   */
  @Post('ai/digest')
  aiDigest(@CurrentUser() u: AuthUser) {
    return this.chats.aiDigest(u.tenantId, u);
  }

  /** Поиск по переписке словами — только по тому, что доступно спрашивающему. */
  @Post('ai/search')
  aiSearch(@CurrentUser() u: AuthUser, @Body() dto: AiSearchDto) {
    return this.chats.aiSearch(u.tenantId, u, dto.query);
  }

  /**
   * Внешний чат: разговор с клиентом или подрядчиком по ссылке.
   *
   * Отдельный от внутренних намеренно: «клиент опять поменял требования» говорят во
   * внутреннем чате проекта, и уехать клиенту оно не может.
   */
  @Post('external')
  createExternal(@CurrentUser() u: AuthUser, @Body() dto: CreateExternalDto) {
    return this.chats.createExternal(u.tenantId, u, dto);
  }

  /** Чат с собой — «Заметки». Открывается один и тот же, сколько ни нажимай. */
  @Post('self')
  selfChat(@CurrentUser() u: AuthUser) {
    return this.chats.selfChat(u.tenantId, u);
  }

  /**
   * Откуда выросла задача. По образцу `/meetings/of-task/:id` — вопрос тот же:
   * «а это вообще откуда?», и отвечать на него должны все источники одинаково.
   */
  @Get('of-task/:taskId')
  sourceMessage(@CurrentUser() u: AuthUser, @Param('taskId') taskId: string) {
    return this.chats.sourceMessage(u.tenantId, taskId);
  }

  @Get('saved')
  saved(@CurrentUser() u: AuthUser) {
    return this.chats.saved(u.tenantId, u);
  }

  @Get('mentions')
  mentions(@CurrentUser() u: AuthUser) {
    return this.chats.mentions(u.tenantId, u);
  }

  /** Всё, что ждёт человека, одной лентой: позвали, ответили в ветке, написали. */
  @Get('inbox')
  inbox(@CurrentUser() u: AuthUser) {
    return this.chats.inbox(u.tenantId, u);
  }

  @Get(':id/messages')
  messages(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('before') before?: string) {
    return this.chats.messages(u.tenantId, id, u, before);
  }

  @Post(':id/messages')
  send(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: SendDto) {
    return this.chats.send(u.tenantId, id, u, dto.body ?? '', null, {
      rootId: dto.threadRootId ?? null,
      alsoInChannel: dto.alsoInChannel === true,
    }, dto.mentionIds);
  }

  /**
   * Клип: голосовое сообщение или запись экрана.
   *
   * Расшифровка кладётся в тело сообщения — иначе аудио и видео становятся чёрной
   * дырой: их не найдёт поиск, не увидит сводка и не разберёт помощник.
   */
  @Post(':id/clip')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  sendClip(
    @CurrentUser() u: AuthUser, @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File, @Body() body: { kind?: string },
  ) {
    if (!file) throw AppException.validation('Запись не получена');
    return this.chats.sendClip(u.tenantId, id, u, file, body?.kind === 'screen' ? 'screen' : 'voice');
  }

  /** Вопрос помощнику в этом чате: ответ ложится в ту же переписку, при всех. */
  @Post(':id/ai')
  askAi(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: AskAiDto) {
    return this.chats.askAi(u.tenantId, id, u, dto.question);
  }

  /** Сводка непрочитанного в этом чате: «47 непрочитанных» — не ответ на «что там». */
  @Post(':id/ai/digest')
  chatDigest(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.chats.aiDigest(u.tenantId, u, id);
  }

  /** Вступить в публичный канал. В приватный — только по приглашению. */
  @Post(':id/join')
  join(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.chats.joinChannel(u.tenantId, id, u);
  }

  /** Закрепить чат сверху списка или снять — порядок личный. */
  @Post(':id/favorite')
  favorite(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.chats.toggleFavorite(u.tenantId, id, u);
  }

  /** Реакция на сообщение — переключатель: повторное нажатие снимает свою. */
  @Post(':id/messages/:mid/reactions')
  react(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('mid') mid: string, @Body() dto: ReactionDto) {
    return this.chats.react(u.tenantId, id, u, mid, dto.emoji);
  }

  /**
   * Задача из сообщения — то, ради чего чат внутри CRM и нужен.
   *
   * Сначала черновик (ИИ раскладывает фразу на постановку, шаги и срок), потом
   * создание: формулировку человек правит сам, ИИ за него задачи не ставит.
   */
  @Post(':id/messages/:mid/task/draft')
  taskDraft(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('mid') mid: string) {
    return this.chats.taskDraft(u.tenantId, id, u, mid);
  }

  @Post(':id/messages/:mid/task')
  createTask(
    @CurrentUser() u: AuthUser, @Param('id') id: string, @Param('mid') mid: string,
    @Body() dto: Record<string, unknown>,
  ) {
    return this.chats.createTask(u.tenantId, id, u, mid, dto);
  }

  /** Что за сущность стоит за чатом: проект, его статус и сколько задач горит. */
  @Get(':id/context')
  context(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.chats.context(u.tenantId, id, u);
  }

  /** Сохранить сообщение себе — переключатель, как реакция. */
  @Post(':id/messages/:mid/save')
  save(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('mid') mid: string) {
    return this.chats.toggleSaved(u.tenantId, id, u, mid);
  }

  /** Напомнить об этом сообщении в назначенный момент. */
  @Post(':id/messages/:mid/remind')
  remind(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('mid') mid: string, @Body() dto: RemindDto) {
    return this.chats.remind(u.tenantId, id, u, mid, dto.remindAt);
  }

  /** «Пометить как непрочитанное» с этого сообщения: оно и всё после него — снова новые. */
  @Post(':id/messages/:mid/unread')
  unreadFrom(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('mid') mid: string) {
    return this.chats.markUnreadFrom(u.tenantId, id, u, mid);
  }

  /** Закрепить сообщение в шапке чата или снять закрепление. */
  @Post(':id/messages/:mid/pin')
  pin(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('mid') mid: string, @Body() dto: PinDto) {
    return this.chats.pin(u.tenantId, id, u, mid, dto.pinned !== false);
  }

  @Get(':id/pinned')
  pinned(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.chats.pinnedList(u.tenantId, id, u);
  }

  /** Ветка обсуждения: корневое сообщение и ответы. */
  @Get(':id/threads/:rootId')
  thread(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('rootId') rootId: string) {
    return this.chats.thread(u.tenantId, id, u, rootId);
  }

  /**
   * Файлы сообщением: одним запросом можно прислать несколько.
   *
   * Поле называется `files`, но принимаем и старое `file` — на него ходят
   * страницы, открытые до выкладки, и ронять им отправку нельзя.
   */
  @Post(':id/files')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileFieldsInterceptor([{ name: 'files', maxCount: 10 }, { name: 'file', maxCount: 1 }]))
  sendFile(
    @CurrentUser() u: AuthUser, @Param('id') id: string,
    @UploadedFiles() got: { files?: Express.Multer.File[]; file?: Express.Multer.File[] },
    @Body() dto: SendDto,
  ) {
    const list = [...(got?.files ?? []), ...(got?.file ?? [])];
    if (!list.length) throw AppException.validation('Файл не приложен');
    return this.chats.sendFiles(u.tenantId, id, u, list, dto.body ?? '', {
      rootId: dto.threadRootId ?? null,
      alsoInChannel: dto.alsoInChannel === true,
    });
  }

  // ───── управление группой ─────

  @Get(':id/members')
  members(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.chats.members(u.tenantId, id, u);
  }

  // ───── сайдбар чата (ТЗ-5, этап 2) ─────

  /** Сведения, участники по ролям, счётчики материалов — одним запросом. */
  @Get(':id/info')
  info(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.chats.info(u.tenantId, id, u);
  }

  /** Материалы: media | voice | docs | files | links. */
  @Get(':id/materials')
  materials(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('kind') kind = 'files', @Query('before') before?: string) {
    return this.chats.materials(u.tenantId, id, u, kind, before || undefined);
  }

  @Get(':id/saved')
  savedInChat(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.chats.savedInChat(u.tenantId, id, u);
  }

  @Get(':id/audit')
  audit(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.chats.auditList(u.tenantId, id, u);
  }

  @Patch(':id/members/:userId/role')
  setMemberRole(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('userId') userId: string, @Body() dto: MemberRoleDto) {
    return this.chats.setMemberRole(u.tenantId, id, u, userId, dto.role);
  }

  @Patch(':id/description')
  setDescription(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: DescriptionDto) {
    return this.chats.setDescription(u.tenantId, id, u, dto.description ?? '');
  }

  @Post(':id/members')
  addMembers(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: AddMembersDto) {
    return this.chats.addMembers(u.tenantId, id, u, dto.userIds);
  }

  @Delete(':id/members/:userId')
  removeMember(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('userId') userId: string) {
    return this.chats.removeMember(u.tenantId, id, u, userId);
  }

  @Patch(':id')
  rename(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: RenameDto) {
    return this.chats.rename(u.tenantId, id, u, dto.title);
  }

  @Post(':id/leave')
  leave(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.chats.leave(u.tenantId, id, u);
  }

  @Post(':id/read')
  read(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.chats.markRead(u.tenantId, id, u);
  }

  /** «Пометить как непрочитанное»: вернуться к разговору позже, как в Telegram. */
  @Post(':id/unread')
  unread(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.chats.markUnread(u.tenantId, id, u);
  }

  /**
   * Поиск по всем чатам. Маршрут статический и стоит выше `:id`-путей: слово
   * «search» не должно приниматься за номер чата.
   */
  @Get('search')
  searchMessages(@CurrentUser() u: AuthUser, @Query('q') q: string) {
    return this.chats.searchMessages(u.tenantId, u, String(q ?? ''));
  }

  /** Окно сообщений вокруг найденного — переход из поиска. */
  @Get(':id/around/:messageId')
  around(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('messageId') messageId: string) {
    return this.chats.messagesAround(u.tenantId, id, u, messageId);
  }

  /** Отложенные сообщения: написать сейчас, отправить в назначенное время. */
  @Get(':id/scheduled')
  listScheduled(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.chats.listScheduled(u.tenantId, id, u);
  }

  @Post(':id/scheduled')
  schedule(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ScheduleDto) {
    return this.chats.schedule(u.tenantId, id, u, dto.body, dto.sendAt, {
      rootId: dto.rootId ?? null,
      alsoInChannel: dto.alsoInChannel,
      mentionIds: dto.mentionIds,
      repeat: dto.repeat,
    });
  }

  @Patch('scheduled/:sid')
  reschedule(@CurrentUser() u: AuthUser, @Param('sid') sid: string, @Body() dto: RescheduleDto) {
    if (dto.body !== undefined) return this.chats.editScheduled(u.tenantId, sid, u, dto.body);
    return this.chats.rescheduleMessage(u.tenantId, sid, u, dto.sendAt ?? '');
  }

  /** «Отправить сейчас»: передумал ждать — отправляем немедленно. */
  @Post('scheduled/:sid/send')
  sendScheduledNow(@CurrentUser() u: AuthUser, @Param('sid') sid: string) {
    return this.chats.sendScheduledNow(u.tenantId, sid, u);
  }

  @Delete('scheduled/:sid')
  cancelScheduled(@CurrentUser() u: AuthUser, @Param('sid') sid: string) {
    return this.chats.cancelScheduled(u.tenantId, sid, u);
  }

  /** Правка своего сообщения: опечатку исправляют, а не переписывают следом. */
  @Patch(':id/messages/:messageId')
  editMessage(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Body() dto: MessageEditDto,
  ) {
    return this.chats.editMessage(u.tenantId, id, messageId, u, dto.body);
  }

  @Delete(':id/messages/:messageId')
  remove(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('messageId') messageId: string) {
    return this.chats.remove(u.tenantId, id, messageId, u);
  }
}
