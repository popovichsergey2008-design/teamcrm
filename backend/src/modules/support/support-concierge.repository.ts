import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { ManualStatus } from './support-concierge';

/** Данные консьерж-поддержки (ТЗ-29): статусы, смены, обратные звонки, итог, доступ. */
@Injectable()
export class SupportConciergeRepository {
  constructor(private readonly db: DbService) {}

  manualStatuses(userIds: string[]) {
    return this.db.many<{ user_id: string; status: ManualStatus }>(
      `SELECT user_id::text, status FROM support_availability WHERE user_id = ANY($1::bigint[])`,
      [userIds],
    );
  }

  async setManual(userId: string, status: ManualStatus): Promise<void> {
    await this.db.query(
      `INSERT INTO support_availability (user_id, status, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`,
      [userId, status],
    );
  }

  /** У кого есть смены вообще и кто сейчас в смене. */
  shiftState(userIds: string[]) {
    return this.db.many<{ user_id: string; has_shifts: boolean; on_shift: boolean }>(
      `SELECT support_user_id::text AS user_id, TRUE AS has_shifts,
              bool_or(starts_at <= now() AND ends_at > now()) AS on_shift
         FROM support_oncall_shifts
        WHERE support_user_id = ANY($1::bigint[]) AND status = 'planned' AND ends_at > now() - interval '30 days'
        GROUP BY support_user_id`,
      [userIds],
    );
  }

  /** Кто сейчас в созвоне поддержки: идущий созвон по разговору, который он ведёт или начал. */
  inHuddle(userIds: string[]) {
    return this.db.many<{ user_id: string }>(
      `SELECT DISTINCT COALESCE(c.assigned_agent_id, h.started_by)::text AS user_id
         FROM support_huddles h JOIN support_conversations c ON c.id = h.conversation_id
        WHERE h.ended_at IS NULL AND h.started_at > now() - interval '3 hours'
          AND COALESCE(c.assigned_agent_id, h.started_by) = ANY($1::bigint[])`,
      [userIds],
    );
  }

  /** Обращения, ждущие человека и ещё никому не назначенные: это и есть очередь. */
  async queueSize(): Promise<number> {
    const r = await this.db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM support_conversations
        WHERE assigned_agent_id IS NULL AND ai_mode = 'copilot' AND status NOT IN ('resolved', 'closed')`,
    );
    return r?.n ?? 0;
  }

  avatars(userIds: string[]) {
    return this.db.many<{ id: string; avatar_file_id: string | null; tenant_id: string }>(
      `SELECT id::text, avatar_file_id::text, tenant_id::text FROM users WHERE id = ANY($1::bigint[])`,
      [userIds],
    );
  }

  // ── смены ──

  shifts(tenantId: string) {
    return this.db.many<{ id: string; support_user_id: string; full_name: string; starts_at: Date; ends_at: Date; status: string }>(
      `SELECT s.id::text, s.support_user_id::text, u.full_name, s.starts_at, s.ends_at, s.status
         FROM support_oncall_shifts s JOIN users u ON u.id = s.support_user_id
        WHERE s.tenant_id = $1 AND s.ends_at > now() - interval '1 day' AND s.status = 'planned'
        ORDER BY s.starts_at LIMIT 200`,
      [tenantId],
    );
  }

  async addShift(tenantId: string, userId: string, startsAt: Date, endsAt: Date, by: string) {
    return this.db.one<{ id: string }>(
      `INSERT INTO support_oncall_shifts (tenant_id, support_user_id, starts_at, ends_at, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id::text`,
      [tenantId, userId, startsAt, endsAt, by],
    );
  }

  async cancelShift(tenantId: string, id: string): Promise<boolean> {
    const r = await this.db.one<{ id: string }>(
      `UPDATE support_oncall_shifts SET status = 'cancelled' WHERE tenant_id = $1 AND id = $2 AND status = 'planned' RETURNING id::text`,
      [tenantId, id],
    );
    return !!r;
  }

  // ── обратный звонок ──

  async addCallback(tenantId: string, userId: string, conversationId: string | null) {
    await this.db.query(
      `UPDATE support_callbacks SET cancelled_at = now() WHERE user_id = $1 AND notified_at IS NULL AND cancelled_at IS NULL`,
      [userId],
    );
    return this.db.one<{ id: string; created_at: Date }>(
      `INSERT INTO support_callbacks (tenant_id, user_id, conversation_id) VALUES ($1, $2, $3) RETURNING id::text, created_at`,
      [tenantId, userId, conversationId],
    );
  }

  pendingCallback(userId: string) {
    return this.db.one<{ id: string; created_at: Date }>(
      `SELECT id::text, created_at FROM support_callbacks WHERE user_id = $1 AND notified_at IS NULL AND cancelled_at IS NULL
        ORDER BY id DESC LIMIT 1`,
      [userId],
    );
  }

  async cancelCallback(userId: string): Promise<void> {
    await this.db.query(`UPDATE support_callbacks SET cancelled_at = now() WHERE user_id = $1 AND notified_at IS NULL AND cancelled_at IS NULL`, [userId]);
  }

  /** Самый давний ждущий — первым: обратный звонок по очереди, а не всем сразу. */
  async claimCallback(): Promise<{ id: string; tenant_id: string; user_id: string; conversation_id: string | null } | null> {
    return this.db.one(
      `UPDATE support_callbacks SET notified_at = now()
        WHERE id = (SELECT id FROM support_callbacks WHERE notified_at IS NULL AND cancelled_at IS NULL
                     AND created_at > now() - interval '1 day' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id::text, tenant_id::text, user_id::text, conversation_id::text`,
    );
  }

  // ── разговор ──

  async setRecordingConsent(conversationId: string, allow: boolean): Promise<void> {
    await this.db.query(
      `UPDATE support_conversations SET recording_consent = $2, recording_consent_at = now() WHERE id = $1`,
      [conversationId, allow],
    );
  }

  async setResolution(conversationId: string, json: unknown): Promise<void> {
    await this.db.query(
      `UPDATE support_conversations SET resolution_json = $2::jsonb, resolution_at = now(), resolution_feedback = NULL WHERE id = $1`,
      [conversationId, JSON.stringify(json)],
    );
  }

  async setResolutionFeedback(conversationId: string, value: 'works' | 'not_fixed'): Promise<void> {
    await this.db.query(`UPDATE support_conversations SET resolution_feedback = $2 WHERE id = $1`, [conversationId, value]);
  }

  async offerTest(conversationId: string): Promise<void> {
    await this.db.query(`UPDATE support_conversations SET test_offered_at = now() WHERE id = $1`, [conversationId]);
  }

  extras(conversationId: string) {
    return this.db.one<{ recording_consent: boolean | null; resolution_json: Record<string, string> | null; resolution_at: Date | null; resolution_feedback: string | null; test_offered_at: Date | null }>(
      `SELECT recording_consent, resolution_json, resolution_at, resolution_feedback, test_offered_at FROM support_conversations WHERE id = $1`,
      [conversationId],
    );
  }

  // ── доступ на 15 минут ──

  async requestAccess(tenantId: string, conversationId: string, supportUserId: string, reason: string | null) {
    return this.db.one<{ id: string }>(
      `INSERT INTO support_access_grants (tenant_id, conversation_id, support_user_id, reason) VALUES ($1, $2, $3, $4) RETURNING id::text`,
      [tenantId, conversationId, supportUserId, reason],
    );
  }

  grantsOf(conversationId: string) {
    return this.db.many<{
      id: string; support_user_id: string; support_name: string | null; resource_id: string | null; project_name: string | null;
      status: string; reason: string | null; requested_at: Date; granted_at: Date | null; expires_at: Date | null; revoked_at: Date | null;
    }>(
      `SELECT g.id::text, g.support_user_id::text, u.full_name AS support_name, g.resource_id::text, p.name AS project_name,
              g.status, g.reason, g.requested_at, g.granted_at, g.expires_at, g.revoked_at
         FROM support_access_grants g
         LEFT JOIN users u ON u.id = g.support_user_id
         LEFT JOIN projects p ON p.id = g.resource_id
        WHERE g.conversation_id = $1 ORDER BY g.id DESC LIMIT 20`,
      [conversationId],
    );
  }

  grant(conversationId: string, id: string) {
    return this.db.one<{ id: string; tenant_id: string; support_user_id: string; resource_id: string | null; status: string; expires_at: Date | null }>(
      `SELECT id::text, tenant_id::text, support_user_id::text, resource_id::text, status, expires_at
         FROM support_access_grants WHERE conversation_id = $1 AND id = $2`,
      [conversationId, id],
    );
  }

  async decideGrant(id: string, d: { status: 'granted' | 'declined' | 'revoked'; by: string; projectId?: string | null; minutes?: number }) {
    await this.db.query(
      `UPDATE support_access_grants
          SET status = $2::text, granted_by = CASE WHEN $2::text = 'granted' THEN $3::bigint ELSE granted_by END,
              resource_id = COALESCE($4::bigint, resource_id),
              granted_at = CASE WHEN $2::text = 'granted' THEN now() ELSE granted_at END,
              expires_at = CASE WHEN $2::text = 'granted' THEN now() + make_interval(mins => $5::int) ELSE expires_at END,
              revoked_at = CASE WHEN $2::text = 'revoked' THEN now() ELSE revoked_at END
        WHERE id = $1`,
      [id, d.status, d.by, d.projectId ?? null, d.minutes ?? 15],
    );
  }

  async markViewed(id: string): Promise<void> {
    await this.db.query(`UPDATE support_access_grants SET viewed_at = COALESCE(viewed_at, now()) WHERE id = $1`, [id]);
  }

  /** Виден ли проект обратившемуся: разрешить можно только то, что он сам может открыть. */
  async projectVisibleTo(tenantId: string, userId: string, role: string, projectId: string): Promise<boolean> {
    const r = await this.db.one<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM projects p WHERE p.tenant_id = $1 AND p.id = $2
                        AND ($4::boolean OR p.visibility = 'all' OR p.owner_user_id = $3::bigint
                             OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $3::bigint))) AS ok`,
      [tenantId, projectId, userId, role === 'owner' || role === 'manager'],
    );
    return !!r?.ok;
  }

  /** Настройки проекта только на чтение: без задач, файлов и переписки. */
  async projectSnapshot(tenantId: string, projectId: string) {
    const [project, columns, members] = await Promise.all([
      this.db.one<{ id: string; name: string; visibility: string; owner_name: string | null; created_at: Date; client_name: string | null }>(
        `SELECT p.id::text, p.name, p.visibility, u.full_name AS owner_name, p.created_at, c.name AS client_name
           FROM projects p LEFT JOIN users u ON u.id = p.owner_user_id LEFT JOIN clients c ON c.id = p.client_id
          WHERE p.tenant_id = $1 AND p.id = $2`,
        [tenantId, projectId],
      ),
      this.db.many<{ name: string; position: number; tasks: number }>(
        `SELECT c.name, c.position, (SELECT count(*)::int FROM tasks t WHERE t.column_id = c.id AND t.deleted_at IS NULL) AS tasks
           FROM board_columns c WHERE c.tenant_id = $1 AND c.project_id = $2 ORDER BY c.position`,
        [tenantId, projectId],
      ),
      this.db.many<{ full_name: string }>(
        `SELECT u.full_name FROM project_members pm JOIN users u ON u.id = pm.user_id
          WHERE pm.project_id = $1 ORDER BY u.full_name LIMIT 100`,
        [projectId],
      ),
    ]);
    return { project, columns, members };
  }

  /** Идущий созвон поддержки в этой комнате: окно созвона спрашивает, чей он. */
  huddleOfRoom(roomId: string) {
    return this.db.one<{ conversation_id: string; tenant_id: string; user_id: string; recording_consent: boolean | null }>(
      `SELECT c.id::text AS conversation_id, c.tenant_id::text, c.user_id::text, c.recording_consent
         FROM support_huddles h JOIN support_conversations c ON c.id = h.conversation_id
        WHERE h.room_id = $1 AND h.ended_at IS NULL ORDER BY h.id DESC LIMIT 1`,
      [roomId],
    );
  }

  // ── метрики ──

  async metrics() {
    return this.db.one<{ offered: number; accepted: number; resolved: number; fcr: number }>(
      `SELECT (SELECT count(*) FROM support_call_requests WHERE created_at > now() - interval '14 days')::int AS offered,
              (SELECT count(*) FROM support_call_requests WHERE created_at > now() - interval '14 days' AND status = 'accepted')::int AS accepted,
              (SELECT count(*) FROM support_conversations WHERE resolved_at > now() - interval '14 days')::int AS resolved,
              (SELECT count(*) FROM support_conversations WHERE resolved_at > now() - interval '14 days' AND COALESCE(reopens, 0) = 0)::int AS fcr`,
    );
  }
}
