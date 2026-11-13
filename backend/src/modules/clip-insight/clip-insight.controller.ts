import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { ClipInsightService } from './clip-insight.service';

class BugTaskDto {
  /** проект обязателен (ТЗ-31): выбирает человек */
  @IsString() @Matches(/^\d{1,19}$/) projectId!: string;
  @IsOptional() @IsString() @MaxLength(255) title?: string;
  @IsOptional() @IsString() @MaxLength(9000) description?: string;
  @IsOptional() @IsString() @Matches(/^\d{1,19}$/) assigneeId?: string;
}

/**
 * #4902, п. 14: разбор голосовых и записей экрана. Свой префикс, а не /chats/:id/...:
 * там `GET :id` перехватил бы маршруты.
 */
@ApiTags('chats')
@ApiBearerAuth()
@Controller('clip-insight')
@Roles('owner', 'manager', 'member')
export class ClipInsightController {
  constructor(private readonly svc: ClipInsightService) {}

  /** Кратко, реплики с метками, «0:42 баг» — для нескольких сообщений сразу: `?ids=1,2,3`. */
  @Get()
  list(@CurrentUser() u: AuthUser, @Query('ids') ids?: string) {
    return this.svc.list(u, String(ids ?? '').split(',').map((x) => x.trim()).filter(Boolean));
  }

  /** Черновик задачи-бага из записи экрана: название и описание из расшифровки. */
  @Get(':messageId/bug-draft')
  bugDraft(@CurrentUser() u: AuthUser, @Param('messageId') messageId: string) {
    return this.svc.bugDraft(u, messageId);
  }

  /** «Создать задачу-баг с видео». */
  @Post(':messageId/bug-task')
  bugTask(@CurrentUser() u: AuthUser, @Param('messageId') messageId: string, @Body() dto: BugTaskDto) {
    return this.svc.createBug(u, messageId, dto);
  }
}
