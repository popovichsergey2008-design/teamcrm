import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
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
class AddMembersDto {
  @IsArray() @IsString({ each: true }) userIds!: string[];
}
class RenameDto {
  @IsString() @MaxLength(160) title!: string;
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

  @Post(':id/files')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  sendFile(
    @CurrentUser() u: AuthUser, @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File, @Body() dto: SendDto,
  ) {
    if (!file) throw AppException.validation('Файл не приложен');
    return this.chats.sendFile(u.tenantId, id, u, file, dto.body ?? '');
  }

  // ───── управление группой ─────

  @Get(':id/members')
  members(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.chats.members(u.tenantId, id, u);
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

  @Delete(':id/messages/:messageId')
  remove(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('messageId') messageId: string) {
    return this.chats.remove(u.tenantId, id, messageId, u);
  }
}
