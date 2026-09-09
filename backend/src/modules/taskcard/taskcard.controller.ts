import {
  Body, Controller, Delete, Get, Param, Patch, Post, Query, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { TaskAssistantService } from './task-assistant.service';
import { TaskReviewService } from './task-review.service';
import { TaskCardService } from './taskcard.service';

class CommentDto {
  @IsString() @MinLength(1) @MaxLength(5000) body!: string;
  @IsOptional() @IsBoolean() isClientVisible?: boolean;
  /** Ответ на конкретное сообщение: в длинной переписке без этого не разобраться. */
  @IsOptional() @IsString() @MaxLength(32) replyToId?: string;
  /** Выделенный кусок, на который отвечают: в длинном сообщении спорят об одном абзаце. */
  @IsOptional() @IsString() @MaxLength(600) replyExcerpt?: string;
}
class ReactionDto {
  @IsString() @MaxLength(16) emoji!: string;
}
class CommentEditDto {
  @IsString() @MinLength(1) @MaxLength(5000) body!: string;
}
class ChecklistDto {
  @IsString() @MinLength(1) @MaxLength(500) text!: string;
}
class AssistantAskDto {
  @IsString() @MinLength(2) @MaxLength(2000) question!: string;
}
class AssistantChecklistDto {
  @IsArray() @IsString({ each: true }) items!: string[];
}
class ChecklistPatchDto {
  @IsOptional() @IsString() @MaxLength(500) text?: string;
  @IsOptional() @IsBoolean() isDone?: boolean;
}
class WatcherDto {
  @IsOptional() @IsString() userId?: string;
}

@ApiTags('task-card')
@ApiBearerAuth()
@Controller('tasks')
@Roles('owner', 'manager', 'member')
export class TaskCardController {
  constructor(
    private readonly svc: TaskCardService,
    private readonly assistant: TaskAssistantService,
    private readonly review$: TaskReviewService,
  ) {}

  // comments
  @Get(':id/comments')
  /**
   * Переписка задачи. По умолчанию последние сто сообщений: разговор читают с конца,
   * а у импортированной задачи их бывают сотни. `all=1` поднимает всю переписку —
   * этим ходит кнопка «показать предыдущие» и переход к старому сообщению из истории.
   */
  listComments(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('all') all?: string) {
    return this.svc.listComments(u.tenantId, id, u.role, u.userId, all === '1' ? 2000 : 100);
  }
  @Post(':id/comments')
  addComment(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: CommentDto) {
    return this.svc.addComment(u.tenantId, id, u.userId, dto.body, dto.isClientVisible === true, dto.replyToId, {
      replyExcerpt: dto.replyExcerpt ?? null,
    });
  }

  /**
   * Файл сообщением: скриншот показывают в разговоре, а не «см. вложение».
   *
   * Подпись необязательна — картинка часто говорит сама за себя.
   */
  @Post(':id/comments/file')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  addCommentFile(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { body?: string; replyToId?: string; replyExcerpt?: string },
  ) {
    if (!file) throw AppException.validation('file is required');
    return this.svc.addCommentWithFile(
      u.tenantId, id, u.userId, file,
      String(body?.body ?? '').slice(0, 5000),
      body?.replyToId ?? null,
      body?.replyExcerpt ?? null,
    );
  }
  @Patch(':id/comments/:cid')
  editComment(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('cid') cid: string, @Body() dto: CommentEditDto) {
    return this.svc.editComment(u.tenantId, id, cid, u.userId, u.role, dto.body);
  }
  /** Реакция на сообщение — переключатель: повторное нажатие снимает свою. */
  @Post(':id/comments/:cid/reactions')
  react(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Param('cid') cid: string,
    @Body() dto: ReactionDto,
  ) {
    return this.svc.toggleReaction(u.tenantId, id, cid, u.userId, dto.emoji);
  }

  @Delete(':id/comments/:cid')
  delComment(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('cid') cid: string) {
    return this.svc.deleteComment(u.tenantId, id, cid, u.userId, u.role);
  }

  // attachments
  @Get(':id/attachments')
  listAttachments(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.listAttachments(u.tenantId, id);
  }
  @Post(':id/attachments')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  addAttachment(@CurrentUser() u: AuthUser, @Param('id') id: string, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw AppException.validation('file is required');
    return this.svc.attachUploaded(u.tenantId, id, u.userId, file);
  }
  @Delete(':id/attachments/:aid')
  delAttachment(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('aid') aid: string) {
    return this.svc.removeAttachment(u.tenantId, id, aid);
  }

  // checklist
  @Get(':id/checklist')
  listChecklist(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.listChecklist(u.tenantId, id);
  }
  @Post(':id/checklist')
  addChecklist(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ChecklistDto) {
    return this.svc.addChecklist(u.tenantId, id, u.userId, dto.text);
  }
  @Patch(':id/checklist/:iid')
  patchChecklist(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('iid') iid: string, @Body() dto: ChecklistPatchDto) {
    return this.svc.updateChecklist(u.tenantId, id, iid, dto);
  }
  @Delete(':id/checklist/:iid')
  delChecklist(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('iid') iid: string) {
    return this.svc.deleteChecklist(u.tenantId, id, iid);
  }

  /**
   * Спросить помощника по этой задаче.
   *
   * Контекст собирается на сервере: человек не должен пересказывать постановку,
   * чтобы получить ответ по ней.
   */
  @Post(':id/assistant')
  askAssistant(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: AssistantAskDto) {
    return this.assistant.ask(u.tenantId, id, u.userId, dto.question);
  }

  /**
   * «Проверить задачу с помощью ИИ».
   *
   * Собирает карточку целиком — постановку, чек-лист, переписку, документы и
   * скриншоты — и сверяет обещанное с показанным. Отчёт ложится в переписку задачи.
   * Это не приёмка: решение о закрытии остаётся за постановщиком.
   */
  @Post(':id/review')
  review(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.review$.review(u.tenantId, id, u.userId);
  }

  /** Принять предложенный ИИ чек-лист — решение человека, а не ИИ. */
  @Post(':id/assistant/checklist')
  applyAssistantChecklist(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: AssistantChecklistDto) {
    return this.assistant.applyChecklist(u.tenantId, id, u.userId, dto.items).then(() => ({ added: dto.items.length }));
  }

  // labels (assignment on task)
  @Get(':id/labels')
  taskLabels(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.labelsForTask(u.tenantId, id);
  }
  @Post(':id/labels/:labelId')
  assignLabel(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('labelId') labelId: string) {
    return this.svc.assignLabel(u.tenantId, id, labelId, u.userId);
  }
  @Delete(':id/labels/:labelId')
  unassignLabel(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('labelId') labelId: string) {
    return this.svc.unassignLabel(u.tenantId, id, labelId);
  }

  // watchers
  @Post(':id/watchers')
  addWatcher(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: WatcherDto) {
    return this.svc.addWatcher(u.tenantId, id, dto.userId ?? u.userId);
  }
  @Delete(':id/watchers/:userId')
  removeWatcher(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('userId') userId: string) {
    return this.svc.removeWatcher(u.tenantId, id, userId);
  }

  // activity
  @Get(':id/activity')
  activity(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.activityLog(u.tenantId, id);
  }
}
