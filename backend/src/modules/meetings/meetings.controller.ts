import { Body, Controller, Get, Param, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { MeetingsService } from './meetings.service';
import { PostcallService } from './postcall.service';

class CreateMeetingDto {
  @IsString() @MinLength(2) @MaxLength(255) title!: string;
  @IsOptional() @IsString() projectId?: string;
  @IsOptional() @IsString() happenedAt?: string;
  /** Чат, к которому относится встреча: карточка с итогом придёт туда, а сайдбар покажет её в «Митах». */
  @IsOptional() @IsString() chatId?: string;
}

class CompletePostcallDto {
  /** Письмо клиенту отправлено с экрана итогов — разбор закрыт полностью. */
  @IsOptional() @IsBoolean() followupSent?: boolean;
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
  constructor(private readonly meetings: MeetingsService, private readonly postcall: PostcallService) {}

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.meetings.list(u.tenantId, { userId: u.userId, role: u.role });
  }

  @Post()
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateMeetingDto, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw AppException.validation('Приложите запись встречи или файл субтитров (.vtt/.srt)');
    return this.meetings.create(u.tenantId, u.userId, dto, file);
  }

  /** Мои неразобранные итоги встреч (ТЗ-22): плашка «итоги не разобраны». */
  @Get('postcall/pending')
  pendingPostcall(@CurrentUser() u: AuthUser) {
    return this.postcall.pending(u.tenantId, u.userId);
  }

  /** Номер встречи по комнате созвона: экран итогов ждёт, пока допишется запись. */
  @Get('postcall/by-room/:roomId')
  postcallByRoom(@CurrentUser() u: AuthUser, @Param('roomId') roomId: string) {
    return this.meetings.postcallByRoom(u.tenantId, roomId, { userId: u.userId, role: u.role });
  }

  @Get(':id/postcall')
  postcallView(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.meetings.postcallView(u.tenantId, id, { userId: u.userId, role: u.role });
  }

  /** «Разобрать позже»: итоги остаются в списке, напоминание откладывается. */
  @Post(':id/postcall/snooze')
  async snoozePostcall(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.meetings.assertVisible(u.tenantId, id, { userId: u.userId, role: u.role });
    return this.postcall.snooze(u.tenantId, id, u.userId);
  }

  /** «Завершить разбор»: можно и не делать всё — решение человека сохраняется. */
  @Post(':id/postcall/complete')
  async completePostcall(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: CompletePostcallDto) {
    await this.meetings.assertVisible(u.tenantId, id, { userId: u.userId, role: u.role });
    return this.postcall.complete(u.tenantId, id, u.userId, dto.followupSent === true);
  }

  @Get(':id')
  details(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.meetings.details(u.tenantId, id, { userId: u.userId, role: u.role });
  }

  @Post(':id/retry')
  async retry(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.meetings.assertVisible(u.tenantId, id, { userId: u.userId, role: u.role });
    return this.meetings.retry(u.tenantId, id);
  }

  /** Подтверждение черновика — единственный путь, которым встреча превращается в задачу. */
  @Post('drafts/:draftId/apply')
  async apply(@CurrentUser() u: AuthUser, @Param('draftId') draftId: string, @Body() dto: ApplyDraftDto) {
    await this.meetings.assertDraftVisible(u.tenantId, draftId, { userId: u.userId, role: u.role });
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
  async updateDraft(@CurrentUser() u: AuthUser, @Param('draftId') draftId: string, @Body() dto: ApplyDraftDto) {
    await this.meetings.assertDraftVisible(u.tenantId, draftId, { userId: u.userId, role: u.role });
    return this.meetings.updateDraft(u.tenantId, draftId, dto);
  }

  @Post('drafts/:draftId/reject')
  async reject(@CurrentUser() u: AuthUser, @Param('draftId') draftId: string) {
    await this.meetings.assertDraftVisible(u.tenantId, draftId, { userId: u.userId, role: u.role });
    return this.meetings.rejectDraft(u.tenantId, draftId);
  }
}
