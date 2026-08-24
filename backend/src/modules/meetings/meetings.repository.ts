import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { Reply } from './transcript.util';

export interface MeetingRow {
  id: string; tenant_id: string; project_id: string | null; title: string;
  happened_at: Date | null; source: string; file_id: string | null; duration_sec: number | null;
  status: string; error: string | null; created_by: string | null; created_at: Date;
}

export interface DraftRow {
  id: string; meeting_id: string; title: string; description: string | null;
  assignee_id: string | null; assignee_hint: string | null; project_id: string | null;
  project_hint: string | null; column_id: string | null; column_hint: string | null;
  author_id: string | null; author_hint: string | null;
  deadline_at: Date | null; quote: string | null; status: string; task_id: string | null;
}

@Injectable()
export class MeetingsRepository {
  constructor(private readonly db: DbService) {}

  create(i: { tenantId: string; projectId: string | null; title: string; happenedAt: string | null; source: string; fileId: string | null; createdBy: string | null }) {
    return this.db.one<MeetingRow>(
      `INSERT INTO meetings (tenant_id, project_id, title, happened_at, source, file_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [i.tenantId, i.projectId, i.title, i.happenedAt, i.source, i.fileId, i.createdBy],
    ) as Promise<MeetingRow>;
  }

  get(tenantId: string, id: string) {
    return this.db.one<MeetingRow>(`SELECT * FROM meetings WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }

  list(tenantId: string) {
    return this.db.many<MeetingRow & { drafts_pending: number }>(
      `SELECT m.*, (SELECT count(*)::int FROM meeting_task_drafts d
                     WHERE d.meeting_id=m.id AND d.status='pending') AS drafts_pending
         FROM meetings m WHERE m.tenant_id=$1 ORDER BY m.created_at DESC LIMIT 100`,
      [tenantId],
    );
  }

  async setStatus(id: string, status: string, error: string | null = null): Promise<void> {
    await this.db.query(`UPDATE meetings SET status=$2, error=$3, updated_at=now() WHERE id=$1`, [id, status, error]);
  }
  async setDuration(id: string, seconds: number): Promise<void> {
    await this.db.query(`UPDATE meetings SET duration_sec=$2, updated_at=now() WHERE id=$1`, [id, seconds]);
  }

  /** Стенограмма пишется целиком: повторная обработка заменяет прежнюю, а не дописывает. */
  async replaceSegments(
    tenantId: string, meetingId: string,
    replies: (Reply & { speakerUserId?: string | null })[],
  ): Promise<void> {
    await this.db.withTransaction(async (c) => {
      await c.query(`DELETE FROM meeting_segments WHERE meeting_id=$1`, [meetingId]);
      for (const [idx, r] of replies.entries()) {
        await c.query(
          `INSERT INTO meeting_segments (tenant_id, meeting_id, idx, start_sec, end_sec, speaker, speaker_user_id, text)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [tenantId, meetingId, idx, r.start.toFixed(2), r.end.toFixed(2), r.speaker, r.speakerUserId ?? null, r.text],
        );
      }
    });
  }

  segments(tenantId: string, meetingId: string) {
    return this.db.many<{ idx: number; start_sec: string; end_sec: string | null; speaker: string | null; text: string }>(
      `SELECT idx, start_sec, end_sec, speaker, text FROM meeting_segments
        WHERE tenant_id=$1 AND meeting_id=$2 ORDER BY idx`,
      [tenantId, meetingId],
    );
  }

  async saveSummary(tenantId: string, meetingId: string, summary: string, decisions: string[], risks: string[]): Promise<void> {
    await this.db.query(
      `INSERT INTO meeting_summaries (meeting_id, tenant_id, summary, decisions, risks)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb)
       ON CONFLICT (meeting_id) DO UPDATE SET summary=EXCLUDED.summary, decisions=EXCLUDED.decisions, risks=EXCLUDED.risks`,
      [meetingId, tenantId, summary, JSON.stringify(decisions), JSON.stringify(risks)],
    );
  }

  summary(tenantId: string, meetingId: string) {
    return this.db.one<{ summary: string; decisions: string[]; risks: string[] }>(
      `SELECT summary, decisions, risks FROM meeting_summaries WHERE tenant_id=$1 AND meeting_id=$2`,
      [tenantId, meetingId],
    );
  }

  /** Черновики пересоздаются при повторном разборе — но уже применённые не трогаем. */
  async replaceDrafts(tenantId: string, meetingId: string, drafts: {
    title: string; description: string | null; assigneeId: string | null; assigneeHint: string | null;
    projectId: string | null; projectHint: string | null;
    columnId: string | null; columnHint: string | null;
    authorId: string | null; authorHint: string | null;
    deadlineAt: string | null; quote: string | null;
  }[]): Promise<void> {
    await this.db.withTransaction(async (c) => {
      await c.query(`DELETE FROM meeting_task_drafts WHERE meeting_id=$1 AND status='pending'`, [meetingId]);
      for (const d of drafts) {
        await c.query(
          `INSERT INTO meeting_task_drafts
             (tenant_id, meeting_id, title, description, assignee_id, assignee_hint,
              project_id, project_hint, column_id, column_hint, author_id, author_hint, deadline_at, quote)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [tenantId, meetingId, d.title, d.description, d.assigneeId, d.assigneeHint,
            d.projectId, d.projectHint, d.columnId, d.columnHint, d.authorId, d.authorHint, d.deadlineAt, d.quote],
        );
      }
    });
  }

  /** Проекты арендатора вместе с колонками — контекст для разбора встречи. */
  projectsWithColumns(tenantId: string) {
    return this.db.many<{ id: string; name: string; columns: { id: string; name: string }[] }>(
      `SELECT p.id, p.name,
              COALESCE(json_agg(json_build_object('id', c.id, 'name', c.name) ORDER BY c.position)
                       FILTER (WHERE c.id IS NOT NULL), '[]') AS columns
         FROM projects p
    LEFT JOIN board_columns c ON c.project_id = p.id
        WHERE p.tenant_id = $1 AND p.status <> 'archived'
        GROUP BY p.id, p.name
        ORDER BY p.name`,
      [tenantId],
    );
  }

  drafts(tenantId: string, meetingId: string) {
    return this.db.many<DraftRow>(
      `SELECT * FROM meeting_task_drafts WHERE tenant_id=$1 AND meeting_id=$2 ORDER BY id`,
      [tenantId, meetingId],
    );
  }

  draft(tenantId: string, id: string) {
    return this.db.one<DraftRow>(`SELECT * FROM meeting_task_drafts WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }

  async markDraftApplied(id: string, taskId: string): Promise<void> {
    await this.db.query(`UPDATE meeting_task_drafts SET status='applied', task_id=$2 WHERE id=$1`, [id, taskId]);
  }
  async markDraftRejected(id: string): Promise<void> {
    await this.db.query(`UPDATE meeting_task_drafts SET status='rejected' WHERE id=$1`, [id]);
  }

  /** Сотрудники организации — для сопоставления имени, прозвучавшего на встрече. */
  teamMembers(tenantId: string) {
    return this.db.many<{ id: string; full_name: string; email: string | null }>(
      `SELECT id, full_name, email FROM users WHERE tenant_id=$1 AND is_active=TRUE`, [tenantId]);
  }
}
