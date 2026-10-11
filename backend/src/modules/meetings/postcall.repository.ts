import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export type PostcallBlock = 'transcript' | 'summary' | 'decisions' | 'tasks' | 'followup';
export type BlockStatus = 'pending' | 'running' | 'ready' | 'failed' | 'skipped';
export const BLOCKS: PostcallBlock[] = ['transcript', 'summary', 'decisions', 'tasks', 'followup'];

export interface PostcallRow {
  id: string;
  tenant_id: string;
  meeting_id: string;
  owner_id: string | null;
  status: 'processing' | 'review_required' | 'reviewed' | 'completed';
  ai: boolean;
  transcript_status: BlockStatus;
  summary_status: BlockStatus;
  decisions_status: BlockStatus;
  tasks_status: BlockStatus;
  followup_status: BlockStatus;
  participants: { userId: string; name: string; guest: boolean }[];
  snoozed_until: Date | null;
  opened_at: Date | null;
  reviewed_at: Date | null;
  completed_at: Date | null;
  reminded_at: Date | null;
  created_at: Date;
}

/** Разбор встречи после звонка (ТЗ-22): одна встреча — один разбор. */
@Injectable()
export class PostcallRepository {
  constructor(private readonly db: DbService) {}

  async create(i: {
    tenantId: string; meetingId: string; ownerId: string | null; ai: boolean;
    participants: { userId: string; name: string; guest: boolean }[];
  }): Promise<PostcallRow> {
    const row = await this.db.one<PostcallRow>(
      `INSERT INTO meeting_postcall_reviews (tenant_id, meeting_id, owner_id, ai, participants)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (meeting_id) DO UPDATE SET updated_at = now()
       RETURNING *`,
      [i.tenantId, i.meetingId, i.ownerId, i.ai, JSON.stringify(i.participants)],
    );
    return row!;
  }

  byMeeting(tenantId: string, meetingId: string): Promise<PostcallRow | null> {
    return this.db.one<PostcallRow>(
      `SELECT * FROM meeting_postcall_reviews WHERE tenant_id = $1 AND meeting_id = $2`, [tenantId, meetingId],
    );
  }

  /**
   * Отметить готовность блоков. Как только ни один блок не ждёт и не считается, разбор
   * переходит из «обрабатывается» в «ждёт разбора». Второй шаг повторяемый: два почти
   * одновременных блока сойдутся на одном и том же итоге.
   */
  async setBlocks(meetingId: string, patch: Partial<Record<PostcallBlock, BlockStatus>>): Promise<PostcallRow | null> {
    const sets: string[] = [];
    const params: unknown[] = [meetingId];
    for (const b of BLOCKS) {
      if (!patch[b]) continue;
      params.push(patch[b]);
      sets.push(`${b}_status = $${params.length}`);
    }
    if (sets.length) {
      await this.db.query(
        `UPDATE meeting_postcall_reviews SET ${sets.join(', ')}, updated_at = now() WHERE meeting_id = $1`, params,
      );
    }
    const done = BLOCKS.map((b) => `${b}_status NOT IN ('pending','running')`).join(' AND ');
    await this.db.query(
      `UPDATE meeting_postcall_reviews SET status = 'review_required', updated_at = now()
        WHERE meeting_id = $1 AND status = 'processing' AND ${done}`,
      [meetingId],
    );
    return this.db.one<PostcallRow>(`SELECT * FROM meeting_postcall_reviews WHERE meeting_id = $1`, [meetingId]);
  }

  /** Повторная обработка: блоки снова ждут, разбор снова «обрабатывается». */
  async reset(id: string): Promise<void> {
    await this.db.query(
      `UPDATE meeting_postcall_reviews
          SET status = 'processing', transcript_status = 'pending', summary_status = 'pending',
              decisions_status = 'pending', tasks_status = 'pending', followup_status = 'pending', updated_at = now()
        WHERE id = $1`,
      [id],
    );
  }

  async markOpened(id: string): Promise<void> {
    await this.db.query(`UPDATE meeting_postcall_reviews SET opened_at = COALESCE(opened_at, now()) WHERE id = $1`, [id]);
  }

  async snooze(id: string, until: Date): Promise<void> {
    await this.db.query(`UPDATE meeting_postcall_reviews SET snoozed_until = $2, updated_at = now() WHERE id = $1`, [id, until]);
  }

  /** «Завершить разбор»: reviewed — если письмо клиенту ещё не ушло, иначе completed. */
  async finish(id: string, status: 'reviewed' | 'completed'): Promise<PostcallRow | null> {
    return this.db.one<PostcallRow>(
      `UPDATE meeting_postcall_reviews
          SET status = $2, reviewed_at = COALESCE(reviewed_at, now()),
              completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE completed_at END,
              snoozed_until = NULL, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id, status],
    );
  }

  /** Неразобранные итоги человека. «Разобрать позже» отсюда не убирает — только откладывает напоминание. */
  pendingFor(tenantId: string, userId: string) {
    return this.db.many<{ meeting_id: string; title: string; status: string; created_at: Date; pending_drafts: number }>(
      `SELECT r.meeting_id::text, m.title, r.status, r.created_at,
              (SELECT count(*)::int FROM meeting_task_drafts d WHERE d.meeting_id = r.meeting_id AND d.status = 'pending') AS pending_drafts
         FROM meeting_postcall_reviews r
         JOIN meetings m ON m.id = r.meeting_id
        WHERE r.tenant_id = $1 AND r.owner_id = $2
          AND r.status IN ('processing', 'review_required')
          AND r.created_at > now() - interval '14 days'
        ORDER BY r.created_at DESC LIMIT 20`,
      [tenantId, userId],
    );
  }

  /** Встреча, записанная в этой комнате только что: экран итогов открывается раньше, чем она появится. */
  meetingByRoom(tenantId: string, roomId: string) {
    return this.db.one<{ id: string }>(
      `SELECT id::text FROM meetings
        WHERE tenant_id = $1 AND room_id = $2 AND created_at > now() - interval '6 hours'
        ORDER BY id DESC LIMIT 1`,
      [tenantId, roomId],
    );
  }

  /** Организатор события, из которого начали созвон: он и владелец разбора. */
  eventOrganizer(meetingId: string) {
    return this.db.one<{ id: string }>(
      `SELECT e.created_by::text AS id FROM meetings m JOIN calendar_events e ON e.id = m.event_id WHERE m.id = $1`,
      [meetingId],
    );
  }
}
