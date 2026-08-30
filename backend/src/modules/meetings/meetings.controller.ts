import { Body, Controller, Get, Param, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { MeetingsService } from './meetings.service';

class CreateMeetingDto {
  @IsString() @MinLength(2) @MaxLength(255) title!: string;
  @IsOptional() @IsString() projectId?: string;
  @IsOptional() @IsString() happenedAt?: string;
}

class ApplyDraftDto {
  @IsOptional() @IsString() @MaxLength(255) title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() assigneeId?: string;
  @IsOptional() @IsString() projectId?: string;
}

/** Встречи: загрузка записи → стенограмма → сводка → черновики задач. Заказчику недоступно. */
@ApiTags('meetings')
@ApiBearerAuth()
@Controller('meetings')
@Roles('owner', 'manager', 'member')
export class MeetingsController {
  constructor(private readonly meetings: MeetingsService) {}

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.meetings.list(u.tenantId);
  }

  @Post()
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateMeetingDto, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw AppException.validation('Приложите запись встречи или файл субтитров (.vtt/.srt)');
    return this.meetings.create(u.tenantId, u.userId, dto, file);
  }

  @Get(':id')
  details(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.meetings.details(u.tenantId, id);
  }

  @Post(':id/retry')
  retry(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.meetings.retry(u.tenantId, id);
  }

  /** Подтверждение черновика — единственный путь, которым встреча превращается в задачу. */
  @Post('drafts/:draftId/apply')
  apply(@CurrentUser() u: AuthUser, @Param('draftId') draftId: string, @Body() dto: ApplyDraftDto) {
    return this.meetings.applyDraft(u.tenantId, u.userId, draftId, dto);
  }

  /** Из какой встречи выросла задача — для обратной ссылки в её карточке. */
  @Get('of-task/:taskId')
  ofTask(@CurrentUser() u: AuthUser, @Param('taskId') taskId: string) {
    return this.meetings.meetingOfTask(u.tenantId, taskId);
  }

  /**
   * Правка черновика до создания задачи: название, описание, исполнитель, проект.
   * Отдельно от «применить» — человек правит список в несколько заходов.
   */
  @Post('drafts/:draftId')
  updateDraft(@CurrentUser() u: AuthUser, @Param('draftId') draftId: string, @Body() dto: ApplyDraftDto) {
    return this.meetings.updateDraft(u.tenantId, draftId, dto);
  }

  @Post('drafts/:draftId/reject')
  reject(@CurrentUser() u: AuthUser, @Param('draftId') draftId: string) {
    return this.meetings.rejectDraft(u.tenantId, draftId);
  }
}
