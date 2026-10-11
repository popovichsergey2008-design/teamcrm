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
  recap_sent_at: Date | null;
  notified_at: Date | null;
  created_at: Date;
}

/** Черновик письма клиенту из ящика секретаря (ТЗ-21) — в итогах встречи он же. */
export interface FollowupCard {
  id: string; status: string; result_text: string | null;
  actions: { key: string; label: string; primary?: boolean }[];
  payload: { subject?: string; body?: string; email?: string | null; chatId?: string | null; clientId?: string };
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

  /** Письмо клиенту так и не понадобилось (клиента нет, навык выключен) — блок не ждёт. */
  async settleFollowup(meetingId: string): Promise<void> {
    await this.db.query(
      `UPDATE meeting_postcall_reviews SET followup_status = 'skipped', updated_at = now()
        WHERE meeting_id = $1 AND followup_status IN ('pending', 'running')`,
      [meetingId],
    );
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
          SET status = $2::text, reviewed_at = COALESCE(reviewed_at, now()),
              completed_at = CASE WHEN $2::text = 'completed' THEN now() ELSE completed_at END,
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

  /** Что собралось по встрече — для уведомления «итоги готовы» и рассылки участникам. */
  counts(meetingId: string) {
    return this.db.one<{ title: string; summary: string | null; drafts: number; tasks: number; decisions: number; client_id: string | null }>(
      `SELECT m.title, m.client_id::text AS client_id,
              (SELECT s.summary FROM meeting_summaries s WHERE s.meeting_id = m.id) AS summary,
              (SELECT count(*)::int FROM meeting_task_drafts d WHERE d.meeting_id = m.id AND d.status IN ('pending','failed')) AS drafts,
              (SELECT count(*)::int FROM meeting_task_drafts d WHERE d.meeting_id = m.id AND d.task_id IS NOT NULL) AS tasks,
              (SELECT count(*)::int FROM decisions x WHERE x.meeting_id = m.id AND x.revoked_at IS NULL) AS decisions
         FROM meetings m WHERE m.id = $1`,
      [meetingId],
    );
  }

  /**
   * Кандидат в «Новости» (ТЗ-20) по вехе встречи: дальше его, как и прочих кандидатов,
   * публикует или отклоняет руководитель в разделе «Новости». Повтор — тот же кандидат.
   */
  async addNewsCandidate(c: {
    tenantId: string; meetingId: string; projectId: string | null; type: 'release' | 'milestone';
    title: string; body: string; decisions: string[];
  }): Promise<string | null> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO feed_candidates (tenant_id, type, source_type, source_id, project_id, facts, suggested_title, suggested_body, visibility, confidence)
       VALUES ($1, $2, 'meeting', $3, $4, $5::jsonb, $6, $7, $8, 0.7)
       ON CONFLICT (tenant_id, source_type, source_id) DO NOTHING RETURNING id::text`,
      [c.tenantId, c.type, String(c.meetingId), c.projectId, JSON.stringify({ decisions: c.decisions }),
        c.title.slice(0, 200), c.body.slice(0, 4000), c.projectId ? 'project' : 'all'],
    );
    return row?.id ?? null;
  }

  /** Письмо клиенту по этой встрече — у того, кому его подготовили. */
  followupFor(tenantId: string, userId: string, meetingId: string) {
    return this.db.one<FollowupCard>(
      `SELECT id::text, status, result_text, actions, payload FROM assistant_proposals
        WHERE tenant_id = $1 AND user_id = $2 AND skill = 'followup' AND source_type = 'meeting' AND source_id = $3
        ORDER BY id DESC LIMIT 1`,
      [tenantId, userId, String(meetingId)],
    );
  }

  /** «Отправить итоги участникам» — один раз: занять право отправки атомарно. */
  async claimRecap(id: string): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE meeting_postcall_reviews SET recap_sent_at = now() WHERE id = $1 AND recap_sent_at IS NULL`, [id],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Итоги, которые пора напомнить: сутки без разбора или кончилось «разобрать позже». */
  stale() {
    return this.db.many<{ id: string; tenant_id: string; owner_id: string; meeting_id: string; title: string; created_at: Date; pending_drafts: number }>(
      `SELECT r.id::text, r.tenant_id::text, r.owner_id::text, r.meeting_id::text, m.title, r.created_at,
              (SELECT count(*)::int FROM meeting_task_drafts d WHERE d.meeting_id = r.meeting_id AND d.status IN ('pending','failed')) AS pending_drafts
         FROM meeting_postcall_reviews r JOIN meetings m ON m.id = r.meeting_id
        WHERE r.status = 'review_required' AND r.owner_id IS NOT NULL AND r.reminded_at IS NULL
          AND r.created_at > now() - interval '14 days'
          AND (r.snoozed_until <= now() OR (r.snoozed_until IS NULL AND r.created_at < now() - interval '24 hours'))
        ORDER BY r.id LIMIT 50`,
    );
  }

  async claimRemind(id: string): Promise<boolean> {
    const r = await this.db.query(`UPDATE meeting_postcall_reviews SET reminded_at = now() WHERE id = $1 AND reminded_at IS NULL`, [id]);
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * Качество итогов встречи за период (§52) — по фактам, без отдельной таблицы событий:
   * разборы, черновики (что приняли, что правили), решения, письма клиентам.
   */
  quality(tenantId: string, days: number) {
    return this.db.one<{
      meetings: number; ai_meetings: number; reviewed: number; unreviewed: number; median_review_min: number | null;
      drafts: number; applied: number; rejected: number; open_drafts: number;
      edit_assignee: number; edit_deadline: number; edit_title: number; edit_project: number;
      with_tasks: number; with_decisions: number; followup_ready: number; followup_sent: number; recap_sent: number;
      confirm_all: number; proofs: number; proofs_played: number;
    }>(
      `WITH r AS (
         SELECT * FROM meeting_postcall_reviews WHERE tenant_id = $1 AND created_at > now() - make_interval(days => $2::int)
       ), d AS (
         SELECT d.* FROM meeting_task_drafts d JOIN r ON r.meeting_id = d.meeting_id
       )
       SELECT
         (SELECT count(*)::int FROM r) AS meetings,
         (SELECT count(*)::int FROM r WHERE ai) AS ai_meetings,
         (SELECT count(*)::int FROM r WHERE status IN ('reviewed','completed')) AS reviewed,
         (SELECT count(*)::int FROM r WHERE status = 'review_required' AND created_at < now() - interval '24 hours') AS unreviewed,
         (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM reviewed_at - created_at) / 60))::int
            FROM r WHERE reviewed_at IS NOT NULL) AS median_review_min,
         (SELECT count(*)::int FROM d) AS drafts,
         (SELECT count(*)::int FROM d WHERE task_id IS NOT NULL) AS applied,
         (SELECT count(*)::int FROM d WHERE status = 'rejected') AS rejected,
         (SELECT count(*)::int FROM d WHERE status IN ('pending','failed')) AS open_drafts,
         (SELECT count(*)::int FROM d WHERE task_id IS NOT NULL AND 'assignee' = ANY(edited_fields)) AS edit_assignee,
         (SELECT count(*)::int FROM d WHERE task_id IS NOT NULL AND 'deadline' = ANY(edited_fields)) AS edit_deadline,
         (SELECT count(*)::int FROM d WHERE task_id IS NOT NULL AND 'title' = ANY(edited_fields)) AS edit_title,
         (SELECT count(*)::int FROM d WHERE task_id IS NOT NULL AND 'project' = ANY(edited_fields)) AS edit_project,
         (SELECT count(DISTINCT meeting_id)::int FROM d WHERE task_id IS NOT NULL) AS with_tasks,
         (SELECT count(DISTINCT x.meeting_id)::int FROM decisions x JOIN r ON r.meeting_id = x.meeting_id WHERE x.revoked_at IS NULL) AS with_decisions,
         (SELECT count(*)::int FROM r WHERE followup_status = 'ready') AS followup_ready,
         (SELECT count(*)::int FROM assistant_proposals p JOIN r ON p.source_id = r.meeting_id::text
           WHERE p.tenant_id = $1 AND p.skill = 'followup' AND p.source_type = 'meeting' AND p.status = 'executed'
             AND p.resolved_action IN ('send_chat','send_mail')) AS followup_sent,
         (SELECT count(*)::int FROM r WHERE recap_sent_at IS NOT NULL) AS recap_sent,
         -- ТЗ-25: «Подтвердить всё» и прослушанные фрагменты созвона у задач
         (SELECT count(*)::int FROM r WHERE confirm_all_at IS NOT NULL) AS confirm_all,
         (SELECT count(*)::int FROM task_audio_proofs a JOIN r ON r.meeting_id = a.meeting_id WHERE a.status = 'ready') AS proofs,
         (SELECT count(*)::int FROM task_audio_proofs a JOIN r ON r.meeting_id = a.meeting_id WHERE a.status = 'ready' AND a.play_count > 0) AS proofs_played`,
      [tenantId, days],
    );
  }

  async markConfirmAll(tenantId: string, meetingId: string): Promise<void> {
    await this.db.query(
      `UPDATE meeting_postcall_reviews SET confirm_all_at = COALESCE(confirm_all_at, now()) WHERE tenant_id = $1 AND meeting_id = $2`,
      [tenantId, meetingId],
    );
  }

  /** Сказать владельцу «итоги готовы» — один раз и только если он их ещё не открыл. */
  async claimNotify(id: string): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE meeting_postcall_reviews SET notified_at = now() WHERE id = $1 AND notified_at IS NULL`, [id],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Организатор события, из которого начали созвон: он и владелец разбора. */
  eventOrganizer(meetingId: string) {
    return this.db.one<{ id: string }>(
      `SELECT e.created_by::text AS id FROM meetings m JOIN calendar_events e ON e.id = m.event_id WHERE m.id = $1`,
      [meetingId],
    );
  }
}
