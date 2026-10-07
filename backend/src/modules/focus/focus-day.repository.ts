import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { REVIEW_COLUMN_NAMES } from '../tasks/task-columns';
import { Candidate } from './rule-of-3';
import { DEFAULT_DAY, WorkDay } from './close-day';

export interface PlanRow {
  id: string;
  focus_date: string;
  timezone: string;
  status: string;
  generation_source: string;
  score_version: string;
  accepted_at: Date | null;
  completed_at: Date | null;
  closed_at: Date | null;
  feedback: number | null;
  dismissed: string[];
  created_at: Date;
}

export interface ItemRow {
  id: string;
  plan_id: string;
  item_type: 'task' | 'review' | 'approval';
  task_id: string | null;
  approval_id: string | null;
  rank: number;
  title_snapshot: string;
  priority_score: string;
  deadline_score: string;
  unlock_score: string;
  meeting_score: string;
  base_priority_score: string;
  penalty: string;
  reasons: string[];
  source: string;
  pinned_by_user: boolean;
  status: string;
  change_reason: string | null;
}

/** Живые данные элемента плана: что сейчас с задачей / согласованием. */
export interface ItemLive {
  item_id: string;
  task_title: string | null;
  project_id: string | null;
  project_name: string | null;
  deadline_at: Date | null;
  priority: string | null;
  closed: boolean;
  /** задача удалена или проект больше не виден — названия не показываем */
  gone: boolean;
  in_review: boolean;
  approval_pending: boolean | null;
  approval_subject: string | null;
  checklist_total: number;
  checklist_done: number;
  assignee_name: string | null;
}

/** Условие «проект виден человеку $2» — то же, что в списке проектов. */
const VISIBLE = `($3::boolean OR p.visibility = 'all' OR p.owner_user_id = $2::bigint
                 OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $2::bigint))`;

@Injectable()
export class FocusDayRepository {
  constructor(private readonly db: DbService) {}

  async enabled(tenantId: string): Promise<boolean> {
    const row = await this.db.one<{ focus_v2: boolean }>(`SELECT focus_v2 FROM tenants WHERE id = $1`, [tenantId]);
    return !!row?.focus_v2;
  }

  async setEnabled(tenantId: string, on: boolean): Promise<void> {
    await this.db.query(`UPDATE tenants SET focus_v2 = $2 WHERE id = $1`, [tenantId, on]);
  }

  /** Пояс человека → пояс организации → Москва. */
  async timezone(tenantId: string, userId: string): Promise<string> {
    const row = await this.db.one<{ tz: string | null }>(
      `SELECT COALESCE(u.timezone, t.timezone) AS tz
         FROM users u JOIN tenants t ON t.id = u.tenant_id
        WHERE u.tenant_id = $1 AND u.id = $2`,
      [tenantId, userId],
    );
    return row?.tz || 'Europe/Moscow';
  }

  /**
   * Кандидаты (ТЗ, п. 24–26): только то, где человек САМ должен что-то сделать.
   *
   * - свои открытые задачи (исполнитель), кроме уже сданных на проверку — там ход
   *   за постановщиком;
   * - чужая работа, сданная мне на проверку (я постановщик, задача в колонке проверки);
   * - согласования, которых ждут от меня.
   * Наблюдение, «поручено мной» без действия, закрытое, корзина и архив — не входят.
   *
   * `today` — местная дата человека: закрепление «В сегодня» (focus_date) сверяется с ней.
   */
  async candidates(tenantId: string, userId: string, today: string): Promise<(Candidate & { createdAt: Date })[]> {
    const [own, reviews, approvals] = await Promise.all([
      this.db.many<any>(
        `SELECT t.id, t.title, p.name AS project_name, t.deadline_at, t.priority, t.is_blocked,
                t.estimate_hours, t.focus_date::text AS focus_date, t.created_at,
                (SELECT m.title FROM meeting_task_drafts d JOIN meetings m ON m.id = d.meeting_id
                  WHERE d.task_id = t.id AND d.created_at > now() - interval '24 hours'
                  ORDER BY d.created_at DESC LIMIT 1) AS meeting_title
           FROM tasks t
           JOIN projects p ON p.id = t.project_id
           JOIN board_columns bc ON bc.id = t.column_id
          WHERE t.tenant_id = $1 AND t.assignee_id = $2
            AND t.closed_at IS NULL AND t.deleted_at IS NULL AND p.status <> 'archived'
            AND lower(bc.name) <> ALL($3::text[])
          LIMIT 500`,
        [tenantId, userId, REVIEW_COLUMN_NAMES],
      ),
      this.db.many<any>(
        `SELECT t.id, t.title, p.name AS project_name, t.deadline_at, t.priority, t.created_at,
                ua.full_name AS assignee_name, t.updated_at
           FROM tasks t
           JOIN projects p ON p.id = t.project_id
           JOIN board_columns bc ON bc.id = t.column_id
           LEFT JOIN users ua ON ua.id = t.assignee_id
          WHERE t.tenant_id = $1 AND t.created_by = $2
            AND (t.assignee_id IS NULL OR t.assignee_id <> $2)
            AND t.closed_at IS NULL AND t.deleted_at IS NULL AND p.status <> 'archived'
            AND lower(bc.name) = ANY($3::text[])
          LIMIT 200`,
        [tenantId, userId, REVIEW_COLUMN_NAMES],
      ),
      this.db.many<any>(
        `SELECT a.id, a.subject, a.task_id, a.due_at, a.created_at, au.full_name AS author_name
           FROM approvals a
           JOIN users au ON au.id = a.author_id
          WHERE a.tenant_id = $1 AND a.approver_id = $2 AND a.status = 'pending'
          LIMIT 200`,
        [tenantId, userId],
      ),
    ]);
    const out: (Candidate & { createdAt: Date })[] = [];
    for (const t of own) {
      out.push({
        kind: 'task', key: `task:${t.id}`, taskId: String(t.id), approvalId: null,
        title: t.title, projectName: t.project_name, deadlineAt: t.deadline_at, priority: t.priority,
        isBlocked: !!t.is_blocked, waiting: 0, waitingName: null,
        // Задачу завели из итогов созвона за последние сутки — поручение прозвучало вслух.
        meeting: t.meeting_title ? 100 : 0, meetingTitle: t.meeting_title ?? null,
        pinned: t.focus_date === today, estimateHours: t.estimate_hours != null ? Number(t.estimate_hours) : null,
        createdAt: t.created_at,
      });
    }
    for (const t of reviews) {
      out.push({
        kind: 'review', key: `review:${t.id}`, taskId: String(t.id), approvalId: null,
        title: `Проверить и принять: ${t.title}`, projectName: t.project_name, deadlineAt: t.deadline_at,
        priority: t.priority, isBlocked: false, waiting: 1, waitingName: t.assignee_name ?? null,
        meeting: 0, meetingTitle: null, pinned: false, estimateHours: null,
        // на проверку сдали тогда, когда задачу последний раз трогали
        createdAt: t.updated_at,
      });
    }
    for (const a of approvals) {
      out.push({
        kind: 'approval', key: `approval:${a.id}`, taskId: a.task_id ? String(a.task_id) : null, approvalId: String(a.id),
        title: `Согласовать: ${a.subject}`, projectName: null, deadlineAt: a.due_at, priority: null,
        isBlocked: false, waiting: 1, waitingName: a.author_name ?? null,
        meeting: 0, meetingTitle: null, pinned: false, estimateHours: null, createdAt: a.created_at,
      });
    }
    return out;
  }

  /** Рабочие часы организации; не заданы — день до 18:30, как в ТЗ (п. 79). */
  async workDay(tenantId: string): Promise<WorkDay> {
    const row = await this.db.one<{ work_start: string; work_end: string; weekend_days: number[]; holidays: string[] }>(
      `SELECT work_start::text, work_end::text, weekend_days, holidays::text[] AS holidays
         FROM org_work_settings WHERE tenant_id = $1`,
      [tenantId],
    );
    if (!row) return DEFAULT_DAY;
    return {
      workStart: row.work_start.slice(0, 5), workEnd: row.work_end.slice(0, 5),
      weekendDays: row.weekend_days ?? DEFAULT_DAY.weekendDays,
      holidays: (row.holidays ?? []).map((h) => String(h).slice(0, 10)),
    };
  }

  async workdayState(tenantId: string, userId: string): Promise<{ closedUntil: Date | null; quiet: boolean }> {
    const row = await this.db.one<{ workday_closed_until: Date | null; quiet_after_close: boolean }>(
      `SELECT workday_closed_until, quiet_after_close FROM users WHERE tenant_id = $1 AND id = $2`,
      [tenantId, userId],
    );
    const until = row?.workday_closed_until && new Date(row.workday_closed_until) > new Date() ? row.workday_closed_until : null;
    return { closedUntil: until, quiet: row?.quiet_after_close !== false };
  }

  async setWorkday(tenantId: string, userId: string, until: Date | null, quiet?: boolean): Promise<void> {
    await this.db.query(
      `UPDATE users SET workday_closed_until = $3, quiet_after_close = COALESCE($4, quiet_after_close)
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, userId, until, quiet ?? null],
    );
  }

  /**
   * Итоги дня (п. 81): минуты глубокой работы, сколько раз человек разблокировал
   * коллег (решил согласование, принял сданную работу), сколько было встреч.
   * Границы дня — местные сутки человека: [from, to).
   */
  async daySummary(tenantId: string, userId: string, from: Date, to: Date) {
    const row = await this.db.one<{ deep: number; approvals: number; reviews: number; meetings: number }>(
      `SELECT
         (SELECT COALESCE(SUM(LEAST(s.planned_minutes,
                   EXTRACT(EPOCH FROM (COALESCE(s.ended_at, now()) - s.started_at)) / 60)), 0)::int
            FROM focus_sessions s
           WHERE s.tenant_id = $1 AND s.user_id = $2 AND s.status IN ('completed', 'running', 'paused')
             AND s.started_at >= $3 AND s.started_at < $4) AS deep,
         (SELECT count(*)::int FROM approvals a
           WHERE a.tenant_id = $1 AND a.approver_id = $2 AND a.decided_at >= $3 AND a.decided_at < $4) AS approvals,
         (SELECT count(*)::int FROM focus_day_items i JOIN focus_day_plans p ON p.id = i.plan_id
           WHERE p.tenant_id = $1 AND p.user_id = $2 AND i.item_type = 'review' AND i.status = 'done'
             AND i.updated_at >= $3 AND i.updated_at < $4) AS reviews,
         (SELECT count(DISTINCT e.id)::int FROM calendar_events e
            JOIN calendar_participants cp ON cp.event_id = e.id AND cp.user_id = $2 AND cp.status <> 'declined'
           WHERE e.tenant_id = $1 AND NOT e.all_day AND e.starts_at >= $3 AND e.starts_at < $4 AND e.starts_at < now()) AS meetings`,
      [tenantId, userId, from, to],
    );
    return {
      deepMinutes: Number(row?.deep ?? 0),
      unblocked: Number(row?.approvals ?? 0) + Number(row?.reviews ?? 0),
      meetings: Number(row?.meetings ?? 0),
    };
  }

  async closePlan(planId: string): Promise<void> {
    await this.db.query(
      `UPDATE focus_day_plans SET status = 'closed', closed_at = COALESCE(closed_at, now()), updated_at = now() WHERE id = $1`,
      [planId],
    );
  }

  /** «Закрепить на завтра» — личный план на завтра: только своя задача (п. 84). */
  async pinTomorrow(tenantId: string, userId: string, taskId: string, date: string): Promise<boolean> {
    const r = await this.db.one<{ id: string }>(
      `UPDATE tasks SET focus_date = $4::date, updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND assignee_id = $3 AND closed_at IS NULL AND deleted_at IS NULL
        RETURNING id`,
      [tenantId, taskId, userId, date],
    );
    return !!r;
  }

  plan(tenantId: string, userId: string, date: string): Promise<PlanRow | null> {
    return this.db.one<PlanRow>(
      `SELECT id, focus_date::text AS focus_date, timezone, status, generation_source, score_version,
              accepted_at, completed_at, closed_at, feedback, dismissed, created_at
         FROM focus_day_plans WHERE tenant_id = $1 AND user_id = $2 AND focus_date = $3::date`,
      [tenantId, userId, date],
    );
  }

  /** Создать план дня. Гонка двух вкладок: второй вызов получит уже созданный. */
  async createPlan(tenantId: string, userId: string, date: string, tz: string, source: string, version: string): Promise<{ id: string; created: boolean }> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO focus_day_plans (tenant_id, user_id, focus_date, timezone, generation_source, score_version)
       VALUES ($1, $2, $3::date, $4, $5, $6)
       ON CONFLICT (tenant_id, user_id, focus_date) DO NOTHING
       RETURNING id`,
      [tenantId, userId, date, tz, source, version],
    );
    if (row) return { id: String(row.id), created: true };
    const existing = await this.plan(tenantId, userId, date);
    return { id: String(existing!.id), created: false };
  }

  items(planId: string): Promise<ItemRow[]> {
    return this.db.many<ItemRow>(
      `SELECT * FROM focus_day_items WHERE plan_id = $1 AND status IN ('active', 'done') ORDER BY rank, id`,
      [planId],
    );
  }

  async insertItem(tenantId: string, planId: string, i: {
    type: string; taskId: string | null; approvalId: string | null; rank: number; title: string;
    score: number; deadline: number; unlock: number; meeting: number; base: number; penalty: number;
    reasons: string[]; source: string; pinned: boolean;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO focus_day_items (tenant_id, plan_id, item_type, task_id, approval_id, rank, title_snapshot,
          priority_score, deadline_score, unlock_score, meeting_score, base_priority_score, penalty,
          reasons, source, pinned_by_user)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16)`,
      [tenantId, planId, i.type, i.taskId, i.approvalId, i.rank, i.title.slice(0, 255),
        i.score, i.deadline, i.unlock, i.meeting, i.base, i.penalty, JSON.stringify(i.reasons), i.source, i.pinned],
    );
  }

  async setItemStatus(planId: string, itemId: string, status: string, reason: string | null = null): Promise<boolean> {
    const r = await this.db.one<{ id: string }>(
      `UPDATE focus_day_items SET status = $3, change_reason = COALESCE($4, change_reason), updated_at = now()
        WHERE plan_id = $1 AND id = $2 RETURNING id`,
      [planId, itemId, status, reason],
    );
    return !!r;
  }

  async setPinned(planId: string, itemId: string, pinned: boolean): Promise<boolean> {
    const r = await this.db.one<{ id: string }>(
      `UPDATE focus_day_items SET pinned_by_user = $3, updated_at = now() WHERE plan_id = $1 AND id = $2 RETURNING id`,
      [planId, itemId, pinned],
    );
    return !!r;
  }

  /** Новые места по порядку списка: первое — главная миссия. */
  async reorder(planId: string, ids: string[]): Promise<void> {
    await this.db.query(
      `UPDATE focus_day_items i SET rank = o.pos, updated_at = now()
         FROM unnest($2::bigint[]) WITH ORDINALITY AS o(id, pos)
        WHERE i.plan_id = $1 AND i.id = o.id`,
      [planId, ids],
    );
  }

  /** Активные элементы удаляются при пересчёте — кроме закреплённых и сделанных. */
  async dropUnpinned(planId: string): Promise<void> {
    await this.db.query(
      `UPDATE focus_day_items SET status = 'replaced', change_reason = 'recalc', updated_at = now()
        WHERE plan_id = $1 AND status = 'active' AND NOT pinned_by_user`,
      [planId],
    );
  }

  async setPlan(planId: string, patch: { status?: string; accepted?: boolean; source?: string; feedback?: number | null }): Promise<void> {
    await this.db.query(
      `UPDATE focus_day_plans
          SET status = COALESCE($2, status),
              accepted_at = CASE WHEN $3::boolean AND accepted_at IS NULL THEN now() ELSE accepted_at END,
              generation_source = COALESCE($4, generation_source),
              feedback = CASE WHEN $5::boolean THEN $6::smallint ELSE feedback END,
              updated_at = now()
        WHERE id = $1`,
      [planId, patch.status ?? null, !!patch.accepted, patch.source ?? null, patch.feedback !== undefined, patch.feedback ?? null],
    );
  }

  async dismiss(planId: string, key: string): Promise<void> {
    await this.db.query(
      `UPDATE focus_day_plans SET dismissed = dismissed || to_jsonb($2::text), updated_at = now()
        WHERE id = $1 AND NOT dismissed ? $2`,
      [planId, key],
    );
  }

  /**
   * Что сейчас с элементами: закрыта ли задача, видна ли ещё человеку, ушла ли из
   * проверки, решено ли согласование. Название — только пока проект виден (п. 131).
   */
  live(tenantId: string, viewer: { userId: string; boss: boolean }, planId: string): Promise<ItemLive[]> {
    return this.db.many<ItemLive>(
      `SELECT i.id AS item_id,
              CASE WHEN t.id IS NOT NULL AND t.deleted_at IS NULL AND ${VISIBLE} THEN t.title END AS task_title,
              CASE WHEN t.id IS NOT NULL AND t.deleted_at IS NULL AND ${VISIBLE} THEN t.project_id END AS project_id,
              CASE WHEN t.id IS NOT NULL AND t.deleted_at IS NULL AND ${VISIBLE} THEN p.name END AS project_name,
              t.deadline_at, t.priority,
              (t.closed_at IS NOT NULL) AS closed,
              (i.item_type <> 'approval' AND (t.id IS NULL OR t.deleted_at IS NOT NULL OR NOT ${VISIBLE})) AS gone,
              (lower(bc.name) = ANY($5::text[])) AS in_review,
              (a.status = 'pending') AS approval_pending, a.subject AS approval_subject,
              (SELECT count(*)::int FROM task_checklist_items ci WHERE ci.task_id = t.id) AS checklist_total,
              (SELECT count(*)::int FROM task_checklist_items ci WHERE ci.task_id = t.id AND ci.is_done) AS checklist_done,
              ua.full_name AS assignee_name
         FROM focus_day_items i
         LEFT JOIN tasks t ON t.id = i.task_id
         LEFT JOIN projects p ON p.id = t.project_id
         LEFT JOIN board_columns bc ON bc.id = t.column_id
         LEFT JOIN users ua ON ua.id = t.assignee_id
         LEFT JOIN approvals a ON a.id = i.approval_id
        WHERE i.tenant_id = $1 AND i.plan_id = $4 AND i.status IN ('active', 'done')`,
      [tenantId, viewer.userId, viewer.boss, planId, REVIEW_COLUMN_NAMES],
    );
  }
}
