import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength,
} from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { FeedService } from './feed.service';
import { NewsAgentService } from './news-agent.service';
import { SecurityService } from '../security/security.service';
import { can } from '../security/permissions';
import { FeedRepository } from './feed.repository';

const VIS = ['all', 'department', 'project', 'custom'];

class PostDto {
  @IsOptional() @IsIn(['manual', 'announcement']) type?: 'manual' | 'announcement';
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsString() @MinLength(1) @MaxLength(8000) body!: string;
  /** Старое поле формы: «объявление». Новое — `type`. */
  @IsOptional() @IsBoolean() isAnnouncement?: boolean;
  @IsOptional() @IsIn(VIS) visibility?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(30) groupIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(200) userIds?: string[];
  @IsOptional() @IsString() projectId?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(30) mentionIds?: string[];
  @IsOptional() @IsBoolean() requiresAck?: boolean;
  @IsOptional() @IsDateString() activeUntil?: string;
  @IsOptional() @IsString() @MaxLength(60) ctaLabel?: string;
  @IsOptional() @IsString() @MaxLength(500) ctaUrl?: string;
  @IsOptional() @IsBoolean() pin?: boolean;
}

class PatchDto {
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(8000) body?: string;
  @IsOptional() @IsString() @MaxLength(60) ctaLabel?: string;
  @IsOptional() @IsString() @MaxLength(500) ctaUrl?: string;
  @IsOptional() @IsBoolean() requiresAck?: boolean;
  @IsOptional() @IsDateString() activeUntil?: string;
}

class KudosDto {
  @IsString() toUserId!: string;
  @IsString() @MinLength(3) @MaxLength(1000) text!: string;
  @IsOptional() @IsString() badge?: string;
  @IsOptional() @IsIn(['all', 'department']) visibility?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(30) groupIds?: string[];
}

class PollDto {
  @IsString() @MinLength(3) @MaxLength(300) question!: string;
  @IsArray() @ArrayMaxSize(10) options!: string[];
  @IsOptional() @IsDateString() deadlineAt?: string;
  @IsOptional() @IsBoolean() anonymous?: boolean;
  @IsOptional() @IsBoolean() multiple?: boolean;
  @IsOptional() @IsIn(VIS) visibility?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(30) groupIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(200) userIds?: string[];
  @IsOptional() @IsString() projectId?: string;
}

class VoteDto {
  @IsArray() @ArrayMaxSize(10) optionIds!: string[];
}

class ReleaseDto {
  @IsString() projectId!: string;
  @IsString() @MinLength(3) @MaxLength(200) title!: string;
  @IsOptional() @IsString() @MaxLength(8000) body?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(100) taskIds?: string[];
}

class DecideDto {
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(8000) body?: string;
}

class ReactionDto {
  @IsString() @MaxLength(8) reaction!: string;
}

class CommentDto {
  @IsString() @MinLength(1) @MaxLength(4000) body!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(30) mentionIds?: string[];
}

class PinDto {
  @IsBoolean() pinned!: boolean;
}

class CheckDto {
  @IsString() @MaxLength(8000) text!: string;
}

class SettingsDto {
  @IsOptional() @IsBoolean() highlightsEnabled?: boolean;
  @IsOptional() @IsBoolean() highlightsAuto?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(23) highlightHour?: number;
  @IsOptional() @IsBoolean() heroEnabled?: boolean;
  @IsOptional() @IsBoolean() learningsEnabled?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(7) learningsDow?: number;
  @IsOptional() @IsInt() @Min(0) @Max(23) learningsHour?: number;
}

/**
 * «Новости» (ТЗ-20). Клиентам раздел не показывается. Маршруты без `:id` объявлены
 * выше `:id`-маршрутов — иначе Nest примет «kudos» или «sidebar» за номер поста.
 */
@ApiTags('feed')
@ApiBearerAuth()
@Controller('feed')
@Roles('owner', 'manager', 'member')
export class FeedController {
  constructor(
    private readonly feed: FeedService,
    private readonly agent: NewsAgentService,
    private readonly security: SecurityService,
    private readonly repo: FeedRepository,
  ) {}

  /** Лента: фильтр (all, highlights, kudos, releases, polls, announcements), поиск, курсор. */
  @Get()
  list(@CurrentUser() u: AuthUser, @Query('filter') filter?: string, @Query('q') q?: string, @Query('before') before?: string) {
    return this.feed.list(u.tenantId, u, { filter, q, before });
  }

  @Get('unread')
  unread(@CurrentUser() u: AuthUser) {
    return this.feed.unread(u.tenantId, u);
  }

  /** Открыл раздел — всё до этого момента уже не «новое». */
  @Post('seen')
  seen(@CurrentUser() u: AuthUser) {
    return this.feed.seen(u.tenantId, u);
  }

  @Get('sidebar')
  sidebar(@CurrentUser() u: AuthUser) {
    return this.feed.sidebar(u.tenantId, u);
  }

  @Get('review')
  review(@CurrentUser() u: AuthUser) {
    return this.feed.review(u.tenantId, u);
  }

  @Get('settings')
  settings(@CurrentUser() u: AuthUser) {
    return this.feed.settings(u.tenantId, u);
  }

  @Patch('settings')
  saveSettings(@CurrentUser() u: AuthUser, @Body() dto: SettingsDto) {
    return this.feed.saveSettings(u.tenantId, u, dto as Record<string, unknown>);
  }

  /** Подсказка до публикации: нет ли в тексте пароля, ключа, номера карты (§55). */
  @Post('check')
  check(@Body() dto: CheckDto) {
    return this.feed.check(dto.text);
  }

  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: PostDto) {
    return this.feed.create(u.tenantId, u, { ...dto, type: dto.type ?? (dto.isAnnouncement ? 'announcement' : 'manual') });
  }

  @Post('kudos')
  kudos(@CurrentUser() u: AuthUser, @Body() dto: KudosDto) {
    return this.feed.kudos(u.tenantId, u, dto);
  }

  @Post('polls')
  poll(@CurrentUser() u: AuthUser, @Body() dto: PollDto) {
    return this.feed.createPoll(u.tenantId, u, dto);
  }

  @Post('releases')
  release(@CurrentUser() u: AuthUser, @Body() dto: ReleaseDto) {
    return this.feed.release(u.tenantId, u, dto);
  }

  /** Закрытые задачи проекта за 30 дней — выбрать, что вошло в релиз. */
  @Get('releases/tasks')
  releaseTasks(@CurrentUser() u: AuthUser, @Query('projectId') projectId: string) {
    return this.feed.releaseTasks(u.tenantId, u, projectId);
  }

  /**
   * «Собрать сейчас»: хайлайт за прошлый день или выводы недели — не дожидаясь
   * расписания. Тем же ключом дня: второй раз пост не появится.
   */
  @Post('highlights/generate')
  async generateHighlight(@CurrentUser() u: AuthUser) {
    await this.mayApprove(u);
    return this.agent.dailyHighlight(u.tenantId, await this.repo.timezone(u.tenantId), new Date(), true);
  }

  @Post('learnings/generate')
  async generateLearnings(@CurrentUser() u: AuthUser) {
    await this.mayApprove(u);
    return this.agent.weeklyLearnings(u.tenantId, await this.repo.timezone(u.tenantId), new Date(), true);
  }

  @Post('candidates/detect')
  async detect(@CurrentUser() u: AuthUser) {
    await this.mayApprove(u);
    return { added: await this.agent.detectCandidates(u.tenantId) };
  }

  @Post('candidates/:id/publish')
  publishCandidate(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: DecideDto) {
    return this.feed.publishCandidate(u.tenantId, u, id, dto);
  }

  @Post('candidates/:id/reject')
  rejectCandidate(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.feed.rejectCandidate(u.tenantId, u, id);
  }

  @Delete('comments/:id')
  deleteComment(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.feed.deleteComment(u.tenantId, u, id);
  }

  @Get(':id')
  get(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.feed.get(u.tenantId, u, id);
  }

  @Patch(':id')
  update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: PatchDto) {
    return this.feed.update(u.tenantId, u, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.feed.remove(u.tenantId, u, id);
  }

  /** Черновик системы (хайлайт при одобрении вручную): опубликовать или пропустить. */
  @Post(':id/publish')
  publishDraft(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: DecideDto) {
    return this.feed.publishDraft(u.tenantId, u, id, dto);
  }

  @Post(':id/skip')
  skipDraft(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.feed.skipDraft(u.tenantId, u, id);
  }

  @Post(':id/reactions')
  react(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ReactionDto) {
    return this.feed.react(u.tenantId, u, id, dto.reaction);
  }

  /** «Ознакомился» (§41). Старый путь `/read` — то же самое: так работала кнопка «Прочитал». */
  @Post(':id/ack')
  ack(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.feed.ack(u.tenantId, u, id);
  }

  @Post(':id/read')
  read(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.feed.ack(u.tenantId, u, id);
  }

  @Get(':id/readers')
  readers(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.feed.readers(u.tenantId, u, id);
  }

  @Post(':id/vote')
  vote(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: VoteDto) {
    return this.feed.vote(u.tenantId, u, id, dto.optionIds);
  }

  @Post(':id/close')
  close(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.feed.closePoll(u.tenantId, u, id);
  }

  @Get(':id/voters')
  voters(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.feed.voters(u.tenantId, u, id);
  }

  @Get(':id/comments')
  comments(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('before') before?: string) {
    return this.feed.comments(u.tenantId, u, id, before);
  }

  @Post(':id/comments')
  comment(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: CommentDto) {
    return this.feed.comment(u.tenantId, u, id, dto.body, dto.mentionIds);
  }

  @Post(':id/files')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  attach(@CurrentUser() u: AuthUser, @Param('id') id: string, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw AppException.validation('file is required');
    return this.feed.attach(u.tenantId, u, id, file);
  }

  @Post(':id/pin')
  pin(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: PinDto) {
    return this.feed.pin(u.tenantId, u, id, dto.pinned);
  }

  private async mayApprove(u: AuthUser) {
    const perms = await this.security.permissionsOf(u.tenantId, u.userId);
    if (!can(perms, 'news.approve')) throw AppException.forbidden('Собирать хайлайты вручную может руководство');
  }
}
