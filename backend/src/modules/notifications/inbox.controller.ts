import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsISO8601, IsOptional, Matches } from 'class-validator';
import { AppException } from '../../common/http/app-exception';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { NotificationCenter } from './center.service';
import { INBOX_KIND_TITLES, INBOX_MODES, INBOX_TABS, InboxKind, InboxMode, InboxTab, validSnooze } from './inbox-rules';

class InboxQuery {
  @IsOptional() @IsIn(INBOX_TABS as unknown as string[]) tab?: InboxTab;
  @IsOptional() @Matches(/^\d{1,18}$/) cursor?: string;
}

class SnoozeDto {
  /** До какого момента: клиент считает «завтра 9:00» в своём поясе и шлёт точное время. */
  @IsISO8601() until!: string;
}

const BULK = ['read', 'unread', 'done', 'snooze'] as const;

class BulkDto {
  @IsArray() @ArrayMaxSize(200) @Matches(/^\d{1,18}$/, { each: true }) ids!: string[];
  /** Массово — прочитать, «Готово» и «Отложить»; массового «Принять всё» нет (6.3). */
  @IsIn(BULK as unknown as string[]) action!: (typeof BULK)[number];
  @IsOptional() @IsISO8601() until?: string;
}

class PrefDto {
  @IsIn(Object.keys(INBOX_KIND_TITLES)) kind!: InboxKind;
  @IsIn(INBOX_MODES as unknown as string[]) mode!: InboxMode;
}

class TaskReadDto {
  @Matches(/^\d{1,18}$/) taskId!: string;
}

const ID = /^\d{1,18}$/;

/**
 * «Входящие» (#4807 §6): всё, что ждёт реакции человека, — в одном списке.
 *
 * Строки — из ящика уведомлений; решения по сданной работе клиент берёт живьём из
 * очереди решений (/review/queue), поэтому принятое на доске решение исчезает само.
 * Всё только своё и в своей компании; запись о задаче видна, пока видна задача.
 */
@ApiTags('inbox')
@ApiBearerAuth()
@Controller('inbox')
@Roles('owner', 'manager', 'member')
export class InboxBoxController {
  constructor(private readonly center: NotificationCenter) {}

  @Get()
  list(@CurrentUser() u: AuthUser, @Query() q: InboxQuery) {
    return this.center.inbox(u, q.tab ?? 'important', q.cursor ?? null);
  }

  @Get('counters')
  counters(@CurrentUser() u: AuthUser) {
    return this.center.inboxCounters(u);
  }

  /** #4807 §6.5, п. 6: по каждому типу — «Входящие и push» / «Только входящие» / «Не показывать». */
  @Get('prefs')
  prefs(@CurrentUser() u: AuthUser) {
    return this.center.inboxPrefs(u);
  }

  @Put('prefs')
  setPref(@CurrentUser() u: AuthUser, @Body() dto: PrefDto) {
    return this.center.setInboxPref(u, dto.kind, dto.mode);
  }

  @Post('bulk')
  bulk(@CurrentUser() u: AuthUser, @Body() dto: BulkDto) {
    return this.center.inboxMark(u, dto.ids, dto.action, dto.action === 'snooze' ? untilOf(dto.until) : undefined);
  }

  /** Открыл задачу — её строки прочитаны (не «Готово»). */
  @Post('read-task')
  readTask(@CurrentUser() u: AuthUser, @Body() dto: TaskReadDto) {
    return this.center.inboxReadTask(u, dto.taskId);
  }

  @Post(':id/read')
  read(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.center.inboxMark(u, [idOf(id)], 'read');
  }

  @Post(':id/unread')
  unread(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.center.inboxMark(u, [idOf(id)], 'unread');
  }

  @Post(':id/done')
  done(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.center.inboxMark(u, [idOf(id)], 'done');
  }

  /** Из «Готово» — обратно в список. */
  @Post(':id/undone')
  undone(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.center.inboxMark(u, [idOf(id)], 'undone');
  }

  @Post(':id/snooze')
  snooze(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: SnoozeDto) {
    return this.center.inboxMark(u, [idOf(id)], 'snooze', untilOf(dto.until));
  }
}

function idOf(id: string): string {
  if (!ID.test(id)) throw AppException.validation('Неверный номер записи');
  return id;
}

function untilOf(raw?: string): Date {
  const d = new Date(raw ?? '');
  if (!validSnooze(d)) throw AppException.validation('Отложить можно на время в будущем, не дальше года');
  return d;
}
