import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { RealtimeService } from '../realtime/realtime.service';
import { MeetingsRepository } from './meetings.repository';
import { BlockStatus, PostcallBlock, PostcallRepository, PostcallRow } from './postcall.repository';

/** «Разобрать позже» не прячет итоги — лишь откладывает напоминание о них. */
const SNOOZE_HOURS = 3;

/**
 * Разбор встречи после звонка (ТЗ-22).
 *
 * Звонок закончен не тогда, когда отключился звук, а когда договорённости стали
 * действиями. Разбор — это и есть «стали ли»: увидел ли человек итоги, что создал,
 * закрыл ли. Конвейер встречи отмечает здесь готовность блоков, экран итогов
 * перерисовывается по событию `meeting.postcall`.
 */
@Injectable()
export class PostcallService {
  private readonly log = new Logger(PostcallService.name);

  constructor(
    private readonly repo: PostcallRepository,
    private readonly meetings: MeetingsRepository,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * Завести разбор, как только появилась встреча. Владелец — организатор события,
   * из которого начали созвон, иначе тот, кто созвон начал.
   */
  async start(i: {
    tenantId: string; meetingId: string; startedBy: string | null; ai: boolean;
    attendees: { userId: string; name: string }[];
  }): Promise<PostcallRow | null> {
    try {
      const organizer = await this.repo.eventOrganizer(i.meetingId).catch(() => null);
      const row = await this.repo.create({
        tenantId: i.tenantId, meetingId: i.meetingId, ownerId: organizer?.id ?? i.startedBy, ai: i.ai,
        participants: i.attendees.map((a) => ({
          userId: a.userId.startsWith('guest:') ? '' : a.userId,
          name: a.userId.startsWith('guest:') ? `${a.name} (гость)` : a.name,
          guest: a.userId.startsWith('guest:'),
        })),
      });
      await this.emit(i.tenantId, row);
      return row;
    } catch (e) {
      // без разбора встреча всё равно разберётся — экран лишь не покажет прогресс
      this.log.warn(`разбор встречи ${i.meetingId} не заведён: ${(e as Error).message}`);
      return null;
    }
  }

  /** Отметка конвейера: блок начат / готов / упал. Встречи без разбора (загруженные файлы) — молча мимо. */
  async mark(tenantId: string, meetingId: string, patch: Partial<Record<PostcallBlock, BlockStatus>>): Promise<void> {
    try {
      const row = await this.repo.setBlocks(meetingId, patch);
      if (row) await this.emit(tenantId, row);
    } catch (e) {
      this.log.warn(`разбор встречи ${meetingId}: ${(e as Error).message}`);
    }
  }

  /** Всё, что ещё не готово, — упало: конвейер оборвался, экран не должен крутиться вечно. */
  async failRest(tenantId: string, meetingId: string): Promise<void> {
    const row = await this.repo.byMeeting(tenantId, meetingId);
    if (!row) return;
    const patch: Partial<Record<PostcallBlock, BlockStatus>> = {};
    for (const b of ['transcript', 'summary', 'decisions', 'tasks', 'followup'] as PostcallBlock[]) {
      const s = row[`${b}_status` as const];
      if (s === 'pending' || s === 'running') patch[b] = b === 'followup' ? 'skipped' : 'failed';
    }
    await this.mark(tenantId, meetingId, patch);
  }

  /** Перезапуск конвейера: блоки снова ждут, разбор снова «обрабатывается». */
  async restart(tenantId: string, meetingId: string): Promise<void> {
    const row = await this.repo.byMeeting(tenantId, meetingId);
    if (!row || row.status === 'completed') return;
    await this.repo.reset(row.id);
    await this.mark(tenantId, meetingId, {});
  }

  review(tenantId: string, meetingId: string) {
    return this.repo.byMeeting(tenantId, meetingId);
  }

  async opened(row: PostcallRow): Promise<void> {
    if (!row.opened_at) await this.repo.markOpened(row.id);
  }

  meetingByRoom(tenantId: string, roomId: string) {
    return this.repo.meetingByRoom(tenantId, roomId);
  }

  pending(tenantId: string, userId: string) {
    return this.repo.pendingFor(tenantId, userId);
  }

  /** Закрывает разбор владелец; у разбора без владельца — любой сотрудник, кто видит встречу. */
  canClose(row: PostcallRow, userId: string): boolean {
    return !row.owner_id || String(row.owner_id) === String(userId);
  }

  async snooze(tenantId: string, meetingId: string, userId: string) {
    const row = await this.own(tenantId, meetingId, userId);
    const until = new Date(Date.now() + SNOOZE_HOURS * 3600_000);
    await this.repo.snooze(row.id, until);
    return { snoozedUntil: until };
  }

  /**
   * «Завершить разбор». Не заставляем делать всё: часть черновиков может остаться,
   * письмо — не уйти. Разбор всё равно закрыт, решение человека сохранено.
   */
  async complete(tenantId: string, meetingId: string, userId: string, followupSent: boolean) {
    const row = await this.own(tenantId, meetingId, userId);
    const status = row.followup_status === 'ready' && !followupSent ? 'reviewed' : 'completed';
    const done = await this.repo.finish(row.id, status);
    if (done) await this.emit(tenantId, done);
    return { status };
  }

  private async own(tenantId: string, meetingId: string, userId: string): Promise<PostcallRow> {
    const row = await this.repo.byMeeting(tenantId, meetingId);
    if (!row) throw AppException.notFound('Итогов у этой встречи нет');
    if (!this.canClose(row, userId)) throw AppException.forbidden('Разбор закрывает организатор встречи');
    return row;
  }

  /** Событие всем, кто ждёт итогов: участникам встречи и владельцу разбора. */
  private async emit(tenantId: string, row: PostcallRow): Promise<void> {
    const people = await this.meetings.audience(tenantId, row.meeting_id).catch(() => []);
    const ids = new Set(people.map((p) => String(p.user_id)));
    if (row.owner_id) ids.add(String(row.owner_id));
    for (const p of row.participants ?? []) if (p.userId) ids.add(String(p.userId));
    this.realtime.emitToUsers(tenantId, [...ids], 'meeting.postcall', {
      meetingId: String(row.meeting_id), status: row.status, blocks: blocksOf(row),
    });
  }
}

export function blocksOf(row: PostcallRow): Record<PostcallBlock, BlockStatus> {
  return {
    transcript: row.transcript_status, summary: row.summary_status, decisions: row.decisions_status,
    tasks: row.tasks_status, followup: row.followup_status,
  };
}
