import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { REVIEW_COLUMN_NAMES } from '../tasks/task-columns';
import { Priority, TaskFact } from './pulse-rules';

/** Виды записей ленты задачи, которые считаются движением (§22): не «посмотрел», а сделал. */
const MOVE_KINDS = ['moved', 'commented', 'attached', 'checklist', 'updated', 'approval_requested', 'approval_confirmed',
  'approval_returned', 'deadline_shifted', 'participant_added', 'directions', 'label', 'followup_on_track', 'followup_blocked',
  'followup_need_shift', 'via_bot'];

export interface OpenTaskRow extends TaskFact { directions: string[]; projectVisibility: string; createdByName: string | null }

export interface PersonRow {
  id: string; name: string; role: string; norm: number | null; canReceive: boolean; available: boolean;
  meetingHours: number; skills: string[];
}

/**
 * Данные «Пульса» (ТЗ-19). Один проход на экран: открытые задачи с последним
 * движением, люди, статистика закрытий, решения руководителя. Считают правила
 * (pulse-rules.ts), здесь — только выборка.
 */
@Injectable()
export class PulseRepository {
  constructor(private readonly db: DbService) {}

  /** Открытые задачи активных проектов и момент последнего осмысленного движения по каждой. */
  async openTasks(tenantId: string): Promise<OpenTaskRow[]> {
    const rows = await this.db.many<any>(
      `SELECT t.id::text, t.title, t.project_id::text AS "projectId", p.name AS "projectName", p.visibility AS "projectVisibility",
              t.assignee_id::text AS "assigneeId", ua.full_name AS "assigneeName",
              t.created_by::text AS "createdBy", uc.full_name AS "createdByName",
              COALESCE(t.priority, 'normal') AS priority, t.deadline_at AS "deadlineAt", t.created_at AS "createdAt",
              (lower(bc.name) = ANY($2::text[])) AS "inReview", COALESCE(t.is_blocked, false) AS "isBlocked",
              COALESCE(t.directions, '{}') AS directions,
              GREATEST(t.created_at,
                COALESCE((SELECT max(a.created_at) FROM task_activity a WHERE a.task_id = t.id AND a.kind = ANY($3::text[])), t.created_at),
                COALESCE((SELECT max(m.created_at) FROM chat_messages m WHERE m.task_id = t.id AND m.deleted_at IS NULL AND NOT m.is_ai), t.created_at)
              ) AS "lastMove"
         FROM tasks t
         JOIN projects p ON p.id = t.project_id AND p.status <> 'archived'
         JOIN board_columns bc ON bc.id = t.column_id
    LEFT JOIN users ua ON ua.id = t.assignee_id
    LEFT JOIN users uc ON uc.id = t.created_by
        WHERE t.tenant_id = $1 AND t.closed_at IS NULL AND t.deleted_at IS NULL
        LIMIT 3000`,
      [tenantId, REVIEW_COLUMN_NAMES, MOVE_KINDS],
    );
    return rows.map((r) => ({
      ...r, priority: (['low', 'normal', 'high', 'urgent'].includes(r.priority) ? r.priority : 'normal') as Priority,
      deadlineAt: r.deadlineAt ? new Date(r.deadlineAt) : null, createdAt: new Date(r.createdAt), lastMove: new Date(r.lastMove),
    }));
  }

  /** Люди: норма, «принимает задачи», отпуск сегодня, часы встреч сегодня, направления. */
  people(tenantId: string, dayFrom: Date, dayTo: Date): Promise<PersonRow[]> {
    return this.db.many<PersonRow>(
      `SELECT u.id::text, u.full_name AS name, r.code AS role, u.load_norm_points AS norm,
              COALESCE(u.can_receive_auto_tasks, true) AS "canReceive",
              -- оба параметра — моменты времени (timestamptz) везде: один и тот же $2 как дата и как
              -- момент Postgres не выводит («inconsistent types deduced for parameter»)
              NOT EXISTS (SELECT 1 FROM user_availability a WHERE a.user_id = u.id
                           AND a.from_date <= ($2::timestamptz)::date AND a.to_date >= ($2::timestamptz)::date) AS available,
              COALESCE((SELECT sum(EXTRACT(EPOCH FROM (LEAST(e.ends_at, $3::timestamptz) - GREATEST(e.starts_at, $2::timestamptz))) / 3600)
                          FROM calendar_events e JOIN calendar_participants cp ON cp.event_id = e.id
                         WHERE cp.user_id = u.id AND cp.status <> 'declined' AND NOT e.all_day
                           AND e.starts_at < $3::timestamptz AND e.ends_at > $2::timestamptz), 0)::float AS "meetingHours",
              COALESCE((SELECT array_agg(s.skill) FROM user_skills s WHERE s.user_id = u.id), '{}') AS skills
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.tenant_id = $1 AND u.is_active AND r.code <> 'client'
        ORDER BY u.full_name`,
      [tenantId, dayFrom, dayTo],
    );
  }

  /** Кому открыты проекты «только для своих». */
  async projectMembers(tenantId: string): Promise<Map<string, Set<string>>> {
    const rows = await this.db.many<{ project_id: string; user_id: string }>(
      `SELECT pm.project_id::text, pm.user_id::text FROM project_members pm
         JOIN projects p ON p.id = pm.project_id WHERE p.tenant_id = $1 AND p.visibility = 'members'`,
      [tenantId],
    );
    const out = new Map<string, Set<string>>();
    for (const r of rows) (out.get(r.project_id) ?? out.set(r.project_id, new Set()).get(r.project_id)!).add(r.user_id);
    return out;
  }

  /** Закрытия и заведения: 30 дней, две недели для скорости, лучшая неделя за 8 недель. */
  async stats(tenantId: string) {
    const row = await this.db.one<any>(
      `SELECT
         (SELECT count(*) FROM tasks WHERE tenant_id=$1 AND deleted_at IS NULL AND closed_at > now() - interval '30 days')::int AS closed30,
         (SELECT count(*) FROM tasks WHERE tenant_id=$1 AND deleted_at IS NULL AND created_at > now() - interval '30 days')::int AS created30,
         (SELECT count(*) FROM tasks WHERE tenant_id=$1 AND deleted_at IS NULL AND closed_at > now() - interval '7 days')::int AS last7,
         (SELECT count(*) FROM tasks WHERE tenant_id=$1 AND deleted_at IS NULL AND closed_at > now() - interval '14 days'
            AND closed_at <= now() - interval '7 days')::int AS prev7,
         (SELECT COALESCE(max(n), 0) FROM (
            SELECT count(*) AS n FROM tasks WHERE tenant_id=$1 AND deleted_at IS NULL
               AND closed_at > now() - interval '63 days' AND closed_at <= now() - interval '7 days'
             GROUP BY floor(EXTRACT(EPOCH FROM (now() - closed_at)) / 604800)) w)::int AS best_prev`,
      [tenantId],
    );
    return {
      closed30: Number(row?.closed30 ?? 0), created30: Number(row?.created30 ?? 0),
      last7: Number(row?.last7 ?? 0), prev7: Number(row?.prev7 ?? 0), bestPrev: Number(row?.best_prev ?? 0),
    };
  }

  /** Проекты: срок, закрыто по неделям за 4 недели, закрыт ли полностью за неделю. */
  async projects(tenantId: string) {
    const rows = await this.db.many<any>(
      `SELECT p.id::text, p.name, p.target_date::text AS "targetDate",
              COUNT(t.id) FILTER (WHERE t.closed_at IS NULL)::int AS open,
              COUNT(t.id)::int AS total,
              COUNT(t.id) FILTER (WHERE t.closed_at IS NOT NULL)::int AS closed,
              ARRAY[
                COUNT(t.id) FILTER (WHERE t.closed_at > now() - interval '28 days' AND t.closed_at <= now() - interval '21 days'),
                COUNT(t.id) FILTER (WHERE t.closed_at > now() - interval '21 days' AND t.closed_at <= now() - interval '14 days'),
                COUNT(t.id) FILTER (WHERE t.closed_at > now() - interval '14 days' AND t.closed_at <= now() - interval '7 days'),
                COUNT(t.id) FILTER (WHERE t.closed_at > now() - interval '7 days')
              ]::int[] AS weekly
         FROM projects p
    LEFT JOIN tasks t ON t.project_id = p.id AND t.tenant_id = p.tenant_id AND t.deleted_at IS NULL
        WHERE p.tenant_id = $1 AND p.status <> 'archived'
        GROUP BY p.id, p.name, p.target_date`,
      [tenantId],
    );
    return rows.map((r) => ({ ...r, weekly: (r.weekly ?? [0, 0, 0, 0]).map(Number) })) as {
      id: string; name: string; targetDate: string | null; open: number; total: number; closed: number; weekly: number[];
    }[];
  }

  /**
   * Решения, которые ждут ИМЕННО этого руководителя (§18): согласования, сданное ему
   * на проверку, просьбы о переносе его задач, клиенты с просроченным «следующим
   * шагом», черновики задач с его встреч. Задачи без исполнителя и блокеры — общие
   * для руководства, их добавляет сервис из списка задач.
   */
  async decisions(tenantId: string, userId: string) {
    const [approvals, reviews, shifts, clients, drafts] = await Promise.all([
      this.db.many<any>(
        `SELECT a.id::text, a.subject AS title, au.full_name AS who, a.created_at AS since, a.due_at AS "dueAt", a.task_id::text AS "taskId",
                t.project_id::text AS "projectId"
           FROM approvals a JOIN users au ON au.id = a.author_id LEFT JOIN tasks t ON t.id = a.task_id
          WHERE a.tenant_id=$1 AND a.approver_id=$2 AND a.status='pending' LIMIT 50`, [tenantId, userId]),
      this.db.many<any>(
        `SELECT t.id::text, t.title, ua.full_name AS who, t.updated_at AS since, t.deadline_at AS "dueAt", t.id::text AS "taskId",
                t.project_id::text AS "projectId", t.priority
           FROM tasks t JOIN board_columns bc ON bc.id = t.column_id JOIN projects p ON p.id = t.project_id AND p.status <> 'archived'
      LEFT JOIN users ua ON ua.id = t.assignee_id
          WHERE t.tenant_id=$1 AND t.created_by=$2 AND (t.assignee_id IS NULL OR t.assignee_id <> $2)
            AND t.closed_at IS NULL AND t.deleted_at IS NULL AND lower(bc.name) = ANY($3::text[]) LIMIT 50`, [tenantId, userId, REVIEW_COLUMN_NAMES]),
      this.db.many<any>(
        `SELECT t.id::text, t.title, ua.full_name AS who, t.updated_at AS since, t.deadline_shift_to AS "dueAt", t.id::text AS "taskId",
                t.project_id::text AS "projectId"
           FROM tasks t LEFT JOIN users ua ON ua.id = t.deadline_shift_by
          WHERE t.tenant_id=$1 AND t.created_by=$2 AND t.deadline_shift_to IS NOT NULL AND t.closed_at IS NULL AND t.deleted_at IS NULL LIMIT 50`,
        [tenantId, userId]),
      this.db.many<any>(
        `SELECT c.id::text, c.name AS title, c.next_action AS who, c.next_action_at AS since, c.next_action_at AS "dueAt"
           FROM clients c
          WHERE c.tenant_id=$1 AND c.owner_user_id=$2 AND c.archived_at IS NULL
            AND c.next_action_at IS NOT NULL AND c.next_action_at < now() LIMIT 30`, [tenantId, userId]),
      this.db.many<any>(
        `SELECT m.id::text, m.title, NULL AS who, max(d.created_at) AS since, NULL AS "dueAt", count(*)::int AS n
           FROM meeting_task_drafts d JOIN meetings m ON m.id = d.meeting_id
          WHERE m.tenant_id=$1 AND d.status = 'pending' AND (m.created_by = $2 OR d.assignee_id = $2)
          GROUP BY m.id, m.title LIMIT 20`, [tenantId, userId]),
    ]);
    return { approvals, reviews, shifts, clients, drafts };
  }

  /** «Это не проблема» за неделю — такие пункты не показываем (§72). */
  async dismissed(tenantId: string): Promise<Set<string>> {
    const rows = await this.db.many<{ k: string }>(
      `SELECT DISTINCT kind || ':' || ref AS k FROM radar_feedback WHERE tenant_id=$1 AND created_at > now() - interval '7 days'`, [tenantId],
    );
    return new Set(rows.map((r) => r.k));
  }

  async feedback(tenantId: string, userId: string, kind: string, ref: string, reason: string): Promise<void> {
    await this.db.query(`INSERT INTO radar_feedback (tenant_id, user_id, kind, ref, reason) VALUES ($1,$2,$3,$4,$5)`,
      [tenantId, userId, kind, ref.slice(0, 64), reason]);
  }

  /** Когда по задаче последний раз спрашивали «как идёт работа» из Пульса. */
  async lastNudge(taskId: string): Promise<Date | null> {
    const r = await this.db.one<{ at: Date }>(`SELECT max(sent_at) AS at FROM radar_nudges WHERE task_id=$1`, [taskId]);
    return r?.at ? new Date(r.at) : null;
  }

  async nudged(tenantId: string, taskId: string, userId: string): Promise<void> {
    await this.db.query(`INSERT INTO radar_nudges (tenant_id, task_id, sent_by) VALUES ($1,$2,$3)`, [tenantId, taskId, userId]);
  }

  // ── предложения действий (§47–49) ──
  createProposal(i: { tenantId: string; actorId: string; sourceType: string; sourceId: string | null; actionType: string; payload: Record<string, unknown>; preview: string; reason: string | null }) {
    return this.db.one<{ id: string }>(
      `INSERT INTO radar_action_proposals (tenant_id, actor_user_id, source_type, source_id, action_type, payload_json, preview, reason)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING id::text`,
      [i.tenantId, i.actorId, i.sourceType, i.sourceId, i.actionType, JSON.stringify(i.payload), i.preview, i.reason],
    );
  }

  proposal(tenantId: string, actorId: string, id: string) {
    return this.db.one<{ id: string; action_type: string; payload_json: any; status: string; created_at: Date; preview: string }>(
      `SELECT id::text, action_type, payload_json, status, created_at, preview FROM radar_action_proposals WHERE tenant_id=$1 AND actor_user_id=$2 AND id=$3`,
      [tenantId, actorId, id],
    );
  }

  /** Занять предложение: из «proposed» в «executing» одним запросом — двойное нажатие не выполнит дважды. */
  async claimProposal(id: string): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE radar_action_proposals SET status='executing', confirmed_at=now() WHERE id=$1 AND status='proposed' AND created_at > now() - interval '1 hour'`, [id],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async finishProposal(id: string, status: 'completed' | 'failed' | 'rejected', error?: string | null): Promise<void> {
    await this.db.query(
      `UPDATE radar_action_proposals SET status=$2, error=$3, executed_at = CASE WHEN $4::boolean THEN now() ELSE executed_at END WHERE id=$1`,
      [id, status, error ?? null, status === 'completed'],
    );
  }

  // ── история прогнозов (§75) ──
  async saveForecast(tenantId: string, f: { projectId: string; planDate: string | null; predicted: Date | null; confidence: number; remaining: number; version: string }) {
    await this.db.query(
      `INSERT INTO radar_forecasts (tenant_id, project_id, day, plan_date, predicted_date, confidence, remaining, version)
       VALUES ($1,$2,current_date,$3::date,$4::date,$5,$6,$7)
       ON CONFLICT (project_id, day) DO UPDATE SET plan_date=$3::date, predicted_date=$4::date, confidence=$5, remaining=$6, version=$7`,
      [tenantId, f.projectId, f.planDate, f.predicted ? f.predicted.toISOString().slice(0, 10) : null, f.confidence, f.remaining, f.version],
    );
  }

  async setTargetDate(tenantId: string, projectId: string, date: string | null): Promise<boolean> {
    const r = await this.db.query(`UPDATE projects SET target_date=$3::date WHERE tenant_id=$1 AND id=$2`, [tenantId, projectId, date]);
    return (r.rowCount ?? 0) > 0;
  }

  async setNorm(tenantId: string, userId: string, norm: number | null): Promise<boolean> {
    const r = await this.db.query(`UPDATE users SET load_norm_points=$3 WHERE tenant_id=$1 AND id=$2`, [tenantId, userId, norm]);
    return (r.rowCount ?? 0) > 0;
  }
}
