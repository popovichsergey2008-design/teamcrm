import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { meetingVisibleSql } from '../../common/access/project-visibility';
import { VISIBLE as FEED_VISIBLE } from '../feed/feed.repository';

export interface SnapshotRow {
  id: string;
  tenant_id: string;
  user_id: string;
  brief_date: string;
  timezone: string;
  status: 'generating' | 'ready' | 'failed';
  facts_json: Record<string, unknown>;
  summary_text: string;
  rules_text: string;
  sentences_json: { text: string; refs: string[] }[];
  source_refs_json: { id: string; kind: string; label: string; link: string | null }[];
  actions_json: { kind: string; label: string; link: string }[];
  mentions: string[];
  top_focus_item_ids: string[];
  audio_status: 'none' | 'pending' | 'ready' | 'failed' | 'off';
  audio_file_id: string | null;
  audio_duration_seconds: number | null;
  audio_text_hash: string | null;
  audio_attempts: number;
  audio_error: string | null;
  model: string | null;
  prompt_version: string;
  facts_version: string;
  refresh_count: number;
  feedback: number | null;
  feedback_reason: string | null;
  viewed_at: Date | null;
  generated_at: Date | null;
  updated_at: Date;
}

export interface BriefPrefs {
  enabled: boolean;
  generateAt: string;
  audio: boolean;
  voice: string;
  length: 'short' | 'normal';
  teamSignals: boolean | null;
  clients: boolean | null;
}

export const DEFAULT_PREFS: BriefPrefs = {
  enabled: true, generateAt: '08:30', audio: true, voice: 'alloy', length: 'normal', teamSignals: null, clients: null,
};

/**
 * Данные брифинга (ТЗ-27). Правило одно (п. 54): ни один запрос не отдаёт того, что
 * человек сам не может открыть, — права проверяются здесь, в SQL, ДО того как факты
 * попадут в текст и в модель. Всё — про самого человека: свои задачи, свои обещания,
 * встречи, где он был, и решения, которые ждут именно его.
 */
@Injectable()
export class FocusBriefRepository {
  constructor(private readonly db: DbService) {}

  // ── снимок ──

  snapshot(tenantId: string, userId: string, date: string): Promise<SnapshotRow | null> {
    return this.db.one<SnapshotRow>(
      `SELECT *, brief_date::text AS brief_date FROM daily_brief_snapshots WHERE tenant_id = $1 AND user_id = $2 AND brief_date = $3::date`,
      [tenantId, userId, date],
    );
  }

  byId(id: string): Promise<SnapshotRow | null> {
    return this.db.one<SnapshotRow>(`SELECT *, brief_date::text AS brief_date FROM daily_brief_snapshots WHERE id = $1`, [id]);
  }

  /**
   * Занять сборку: создать снимок «собирается» или перехватить зависший (>2 мин) либо
   * упавший. Две вкладки и утренний тик одновременно — собирает кто-то один.
   */
  async claim(tenantId: string, userId: string, date: string, tz: string, promptVersion: string, force = false): Promise<SnapshotRow | null> {
    const fresh = await this.db.one<SnapshotRow>(
      `INSERT INTO daily_brief_snapshots (tenant_id, user_id, brief_date, timezone, prompt_version)
       VALUES ($1, $2, $3::date, $4, $5)
       ON CONFLICT (tenant_id, user_id, brief_date) DO NOTHING
       RETURNING *, brief_date::text AS brief_date`,
      [tenantId, userId, date, tz, promptVersion],
    );
    if (fresh) return fresh;
    return this.db.one<SnapshotRow>(
      `UPDATE daily_brief_snapshots SET status = 'generating', updated_at = now()
        WHERE tenant_id = $1 AND user_id = $2 AND brief_date = $3::date
          AND (status = 'failed' OR (status = 'generating' AND updated_at < now() - interval '2 minutes')
               OR ($4::boolean AND status = 'ready'))
        RETURNING *, brief_date::text AS brief_date`,
      [tenantId, userId, date, force],
    );
  }

  async saveReady(id: string, s: {
    facts: unknown; summary: string; rules: string; sentences: unknown; sources: unknown; actions: unknown;
    mentions: string[]; topIds: string[]; model: string | null; factsVersion: string; refresh: boolean;
  }): Promise<void> {
    await this.db.query(
      `UPDATE daily_brief_snapshots
          SET status = 'ready', facts_json = $2::jsonb, summary_text = $3, rules_text = $4,
              sentences_json = $5::jsonb, source_refs_json = $6::jsonb, actions_json = $7::jsonb,
              mentions = $8::text[], top_focus_item_ids = $9::bigint[], model = $10, facts_version = $11,
              refresh_count = refresh_count + CASE WHEN $12::boolean THEN 1 ELSE 0 END,
              generated_at = now(), updated_at = now()
        WHERE id = $1`,
      [id, JSON.stringify(s.facts), s.summary, s.rules, JSON.stringify(s.sentences), JSON.stringify(s.sources),
        JSON.stringify(s.actions), s.mentions, s.topIds, s.model, s.factsVersion, s.refresh],
    );
  }

  async markFailed(id: string): Promise<void> {
    await this.db.query(`UPDATE daily_brief_snapshots SET status = 'failed', updated_at = now() WHERE id = $1`, [id]);
  }

  /** Занять синтез голоса: один на снимок, повторы ограничены (п. 62). */
  async claimAudio(id: string, maxAttempts: number, force: boolean): Promise<boolean> {
    const r = await this.db.one<{ id: string }>(
      `UPDATE daily_brief_snapshots SET audio_status = 'pending', audio_attempts = audio_attempts + 1, audio_error = NULL, updated_at = now()
        WHERE id = $1 AND audio_attempts < $2
          AND (audio_status IN ('none', 'failed') OR ($3::boolean AND audio_status = 'ready')
               OR (audio_status = 'pending' AND updated_at < now() - interval '3 minutes'))
        RETURNING id`,
      [id, maxAttempts, force],
    );
    return !!r;
  }

  async setAudio(id: string, a: { status: string; fileId?: string | null; duration?: number | null; textHash?: string | null; error?: string | null }): Promise<void> {
    await this.db.query(
      `UPDATE daily_brief_snapshots
          SET audio_status = $2::text,
              audio_file_id = CASE WHEN $2::text = 'ready' THEN $3::bigint ELSE audio_file_id END,
              audio_duration_seconds = CASE WHEN $2::text = 'ready' THEN $4::int ELSE audio_duration_seconds END,
              audio_text_hash = CASE WHEN $2::text = 'ready' THEN $5 ELSE audio_text_hash END,
              audio_error = $6, updated_at = now()
        WHERE id = $1`,
      [id, a.status, a.fileId ?? null, a.duration ?? null, a.textHash ?? null, a.error ?? null],
    );
  }

  async markViewed(id: string): Promise<boolean> {
    const r = await this.db.one<{ id: string }>(
      `UPDATE daily_brief_snapshots SET viewed_at = now() WHERE id = $1 AND viewed_at IS NULL RETURNING id`,
      [id],
    );
    return !!r;
  }

  async setFeedback(id: string, value: number, reason: string | null): Promise<void> {
    await this.db.query(`UPDATE daily_brief_snapshots SET feedback = $2, feedback_reason = $3, updated_at = now() WHERE id = $1`, [id, value, reason]);
  }

  async event(tenantId: string, userId: string, snapshotId: string | null, event: string): Promise<void> {
    await this.db.query(
      `INSERT INTO focus_brief_events (tenant_id, user_id, snapshot_id, event) VALUES ($1, $2, $3, $4)`,
      [tenantId, userId, snapshotId, event],
    );
  }

  // ── настройки ──

  async prefs(tenantId: string, userId: string): Promise<BriefPrefs> {
    const r = await this.db.one<{ enabled: boolean; generate_at: string; audio: boolean; voice: string; length: string; team_signals: boolean | null; clients: boolean | null }>(
      `SELECT enabled, generate_at, audio, voice, length, team_signals, clients FROM focus_brief_prefs WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId],
    );
    if (!r) return { ...DEFAULT_PREFS };
    return {
      enabled: r.enabled, generateAt: r.generate_at, audio: r.audio, voice: r.voice,
      length: r.length === 'short' ? 'short' : 'normal', teamSignals: r.team_signals, clients: r.clients,
    };
  }

  async savePrefs(tenantId: string, userId: string, p: BriefPrefs): Promise<void> {
    await this.db.query(
      `INSERT INTO focus_brief_prefs (tenant_id, user_id, enabled, generate_at, audio, voice, length, team_signals, clients, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (tenant_id, user_id) DO UPDATE
         SET enabled = EXCLUDED.enabled, generate_at = EXCLUDED.generate_at, audio = EXCLUDED.audio, voice = EXCLUDED.voice,
             length = EXCLUDED.length, team_signals = EXCLUDED.team_signals, clients = EXCLUDED.clients, updated_at = now()`,
      [tenantId, userId, p.enabled, p.generateAt, p.audio, p.voice, p.length, p.teamSignals, p.clients],
    );
  }

  /** Кто был в фокусе за неделю — им брифинг собирается утром заранее (п. 14). */
  activeUsers(): Promise<{ tenant_id: string; user_id: string; role: string; tz: string | null; generate_at: string; full_name: string | null }[]> {
    return this.db.many(
      `SELECT DISTINCT p.tenant_id::text, p.user_id::text, r.code AS role, COALESCE(u.timezone, t.timezone) AS tz,
              COALESCE(bp.generate_at, '08:30') AS generate_at, u.full_name
         FROM focus_day_plans p
         JOIN tenants t ON t.id = p.tenant_id AND t.focus_v2
         JOIN users u ON u.id = p.user_id AND u.is_active IS NOT FALSE
         JOIN roles r ON r.id = u.role_id AND r.code <> 'client'
         LEFT JOIN focus_brief_prefs bp ON bp.tenant_id = p.tenant_id AND bp.user_id = p.user_id
        WHERE p.focus_date >= current_date - 7 AND COALESCE(bp.enabled, TRUE)`,
    );
  }

  async userName(tenantId: string, userId: string): Promise<string | null> {
    const r = await this.db.one<{ full_name: string | null }>(`SELECT full_name FROM users WHERE tenant_id = $1 AND id = $2`, [tenantId, userId]);
    return r?.full_name ?? null;
  }

  // ── факты (все — с правами) ──

  /** Вчерашние встречи, где человек был или которые он завёл, — с решениями; только видимые. */
  meetingsYesterday(tenantId: string, userId: string, boss: boolean, client: boolean, from: Date, to: Date) {
    return this.db.many<{ id: string; title: string; at: Date; decisions: string[] }>(
      `SELECT m.id::text, m.title, COALESCE(m.happened_at, m.created_at) AS at,
              ARRAY(SELECT d.text FROM decisions d WHERE d.meeting_id = m.id AND d.revoked_at IS NULL ORDER BY d.id LIMIT 2) AS decisions
         FROM meetings m
        WHERE m.tenant_id = $1 AND COALESCE(m.happened_at, m.created_at) >= $5 AND COALESCE(m.happened_at, m.created_at) < $6
          AND (m.created_by = $2::bigint OR EXISTS (
                SELECT 1 FROM meeting_postcall_reviews r, jsonb_array_elements(r.participants) e
                 WHERE r.meeting_id = m.id AND e->>'userId' = ($2::bigint)::text))
          AND ${meetingVisibleSql('m', { user: '$2', all: '$3', client: '$4' })}
          AND EXISTS (SELECT 1 FROM decisions d WHERE d.meeting_id = m.id AND d.revoked_at IS NULL)
        ORDER BY at DESC LIMIT 3`,
      [tenantId, userId, boss, client, from, to],
    );
  }

  /** Неразобранные итоги созвонов за двое суток, владелец разбора — он. */
  postcallPending(tenantId: string, userId: string) {
    return this.db.many<{ meeting_id: string; title: string }>(
      `SELECT r.meeting_id::text, m.title
         FROM meeting_postcall_reviews r JOIN meetings m ON m.id = r.meeting_id
        WHERE r.tenant_id = $1 AND r.owner_id = $2 AND r.status = 'review_required'
          AND (r.snoozed_until IS NULL OR r.snoozed_until < now())
          AND r.created_at > now() - interval '48 hours'
        ORDER BY r.created_at DESC LIMIT 3`,
      [tenantId, userId],
    );
  }

  /** Его обещания, которые пора было выполнить: срок наступил или обещал вчера. */
  commitments(tenantId: string, userId: string, yStart: Date, dayEnd: Date) {
    return this.db.many<{ id: string; action_text: string; source_type: string; source_id: string; source_at: Date; task_id: string | null; project_id: string | null }>(
      `SELECT c.id::text, c.action_text, c.source_type, c.source_id::text, c.source_at,
              t.id::text AS task_id, t.project_id::text AS project_id
         FROM commitments c
         LEFT JOIN tasks t ON t.id = c.linked_task_id AND t.deleted_at IS NULL
        WHERE c.tenant_id = $1 AND c.speaker_user_id = $2 AND c.status IN ('detected', 'tracked', 'needs_followup')
          AND (t.id IS NULL OR t.closed_at IS NULL)
          AND ((c.deadline_at IS NOT NULL AND c.deadline_at < $4) OR (c.source_at >= $3 AND c.source_at < $4))
        ORDER BY c.deadline_at NULLS LAST, c.source_at DESC LIMIT 3`,
      [tenantId, userId, yStart, dayEnd],
    );
  }

  /** Своё со сроком сегодня или просроченное — кроме того, что уже в тройке. */
  dueOutside(tenantId: string, userId: string, dayEnd: Date, exclude: string[]) {
    return this.db.many<{ id: string; project_id: string; title: string; deadline_at: Date }>(
      `SELECT t.id::text, t.project_id::text, t.title, t.deadline_at
         FROM tasks t
        WHERE t.tenant_id = $1 AND t.assignee_id = $2 AND t.deleted_at IS NULL AND t.closed_at IS NULL
          AND t.deadline_at IS NOT NULL AND t.deadline_at < $3
          AND NOT (t.id = ANY($4::bigint[]))
        ORDER BY (t.priority = 'urgent') DESC, t.deadline_at LIMIT 3`,
      [tenantId, userId, dayEnd, exclude],
    );
  }

  async waiting(tenantId: string, userId: string) {
    const r = await this.db.one<{ proposals: number; approvals: number; followups: number }>(
      `SELECT (SELECT count(*) FROM assistant_proposals WHERE tenant_id = $1 AND user_id = $2 AND status IN ('new','seen') AND skill NOT IN ('brief', 'followup'))::int AS proposals,
              (SELECT count(*) FROM approvals WHERE tenant_id = $1 AND approver_id = $2 AND status = 'pending')::int AS approvals,
              (SELECT count(*) FROM assistant_proposals WHERE tenant_id = $1 AND user_id = $2 AND status IN ('new','seen') AND skill = 'followup')::int AS followups`,
      [tenantId, userId],
    );
    return { proposals: r?.proposals ?? 0, approvals: r?.approvals ?? 0, followups: r?.followups ?? 0 };
  }

  async calendar(tenantId: string, userId: string, now: Date, dayStart: Date, dayEnd: Date) {
    const [n, first] = await Promise.all([
      this.db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM calendar_events e JOIN calendar_participants p ON p.event_id = e.id AND p.user_id = $2
          WHERE e.tenant_id = $1 AND e.starts_at >= $3 AND e.starts_at < $4 AND p.status <> 'declined'`,
        [tenantId, userId, dayStart, dayEnd],
      ),
      this.db.one<{ id: string; title: string; starts_at: Date }>(
        `SELECT e.id::text, e.title, e.starts_at FROM calendar_events e JOIN calendar_participants p ON p.event_id = e.id AND p.user_id = $2
          WHERE e.tenant_id = $1 AND e.starts_at >= $3 AND e.starts_at < $4 AND p.status <> 'declined' ORDER BY e.starts_at LIMIT 1`,
        [tenantId, userId, now, dayEnd],
      ),
    ]);
    return { count: n?.n ?? 0, first };
  }

  /** Обязательные к прочтению объявления, которые он ещё не подтвердил (п. 48). */
  announcements(tenantId: string, userId: string, owner: boolean) {
    return this.db.many<{ id: string; title: string | null; body: string }>(
      `SELECT p.id::text, p.title, left(p.body, 80) AS body
         FROM feed_posts p
        WHERE ${FEED_VISIBLE('p')} AND p.status = 'published' AND p.type = 'announcement' AND p.requires_ack
          AND (p.active_until IS NULL OR p.active_until > now())
          AND NOT EXISTS (SELECT 1 FROM feed_post_acks a WHERE a.post_id = p.id AND a.user_id = $2::bigint)
        ORDER BY p.id DESC LIMIT 2`,
      [tenantId, userId, owner],
    );
  }

  // ── «Взять в работу» ──

  /** Колонки проекта задачи и где она сейчас — чтобы двигать только вперёд из «к выполнению». */
  taskBoard(tenantId: string, taskId: string) {
    return this.db.one<{ project_id: string; column_id: string; column_name: string; position: number; title: string; assignee_id: string | null; closed: boolean }>(
      `SELECT t.project_id::text, t.column_id::text, c.name AS column_name, c.position, t.title,
              t.assignee_id::text, (t.closed_at IS NOT NULL) AS closed
         FROM tasks t JOIN board_columns c ON c.id = t.column_id
        WHERE t.tenant_id = $1 AND t.id = $2 AND t.deleted_at IS NULL`,
      [tenantId, taskId],
    );
  }

  // ── метрики для руководства (п. 68) ──

  metrics(tenantId: string, days: number) {
    return this.db.one<Record<string, number>>(
      `WITH s AS (SELECT * FROM daily_brief_snapshots WHERE tenant_id = $1 AND brief_date > current_date - $2::int AND status = 'ready'),
            e AS (SELECT * FROM focus_brief_events WHERE tenant_id = $1 AND created_at > now() - make_interval(days => $2::int))
       SELECT (SELECT count(*) FROM s)::int AS briefs,
              (SELECT count(*) FROM s WHERE viewed_at IS NOT NULL)::int AS viewed,
              (SELECT count(DISTINCT snapshot_id) FROM e WHERE event = 'audio_played')::int AS audio_played,
              (SELECT count(*) FROM s WHERE audio_status = 'ready')::int AS audio_ready,
              (SELECT count(DISTINCT snapshot_id) FROM e WHERE event IN ('take_work', 'deep_work_from_brief'))::int AS acted,
              (SELECT count(DISTINCT snapshot_id) FROM e WHERE event = 'deep_work_from_brief')::int AS deep,
              (SELECT count(*) FROM s WHERE feedback = 1)::int AS thumbs_up,
              (SELECT count(*) FROM s WHERE feedback = -1)::int AS thumbs_down,
              (SELECT count(*) FROM s WHERE model IS NOT NULL)::int AS polished`,
      [tenantId, days],
    );
  }
}
