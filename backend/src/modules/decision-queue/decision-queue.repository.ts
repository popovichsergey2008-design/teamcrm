import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { stageSql } from '../tasks/responsibility';
import { QueueItem } from './decision-queue.rules';

/**
 * Кто принимает сданную работу (#4890, п. 13): назначенный проверяющий, а если его нет —
 * постановщик. Тот же человек, которого пускает assertCanDecide (владелец решает за всех,
 * но очередь — не его, пока он не проверяющий и не постановщик).
 */
export const deciderSql = (t = 't', user = '$2') =>
  `(${t}.reviewer_id = ${user} OR (${t}.reviewer_id IS NULL AND ${t}.created_by = ${user}))`;

/** Этапы, где задача ждёт решения проверяющего. «Ждём клиента» — не его ход. */
export const REVIEW_STAGES_SQL = `('testing', 'review', 'approval')`;

/** Открытая задача живого проекта на этапе проверки — общее условие очереди и счётчиков команды. */
const reviewTaskWhere = (t = 't') => `${t}.closed_at IS NULL AND ${t}.deleted_at IS NULL
  AND ${stageSql(t)} IN ${REVIEW_STAGES_SQL}`;

@Injectable()
export class DecisionQueueRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Вся очередь человека одним запросом: сданные ему работы и согласования. Число на
   * экранах — длина этого списка, поэтому «число в списке = число на кнопке» (п. 3).
   * Согласование по задаче, которая и так в очереди проверкой, второй строкой не идёт.
   */
  async items(tenantId: string, userId: string): Promise<QueueItem[]> {
    const rows = await this.db.many<any>(
      `WITH rv AS (
         SELECT t.id, t.title, t.project_id, p.name AS project_name, t.assignee_id, ua.full_name AS assignee_name,
                COALESCE(t.submitted_at, t.updated_at) AS since, t.deadline_at, t.priority
           FROM tasks t
           JOIN projects p ON p.id = t.project_id AND p.status <> 'archived' AND NOT p.is_demo
      LEFT JOIN users ua ON ua.id = t.assignee_id
          WHERE t.tenant_id = $1 AND ${reviewTaskWhere('t')}
            AND (t.assignee_id IS NULL OR t.assignee_id <> $2)
            AND ${deciderSql('t')}
          LIMIT 2000
       )
       SELECT 'review' AS kind, rv.id::text AS task_id, NULL::text AS approval_id, rv.title, rv.project_id::text AS project_id,
              rv.project_name, rv.assignee_id::text AS assignee_id, rv.assignee_name, rv.since, rv.deadline_at, rv.priority
         FROM rv
       UNION ALL
       SELECT 'approval', a.task_id::text, a.id::text, a.subject, t.project_id::text, p.name,
              a.author_id::text, au.full_name, a.created_at, COALESCE(a.due_at, t.deadline_at), t.priority
         FROM approvals a
         JOIN users au ON au.id = a.author_id
    LEFT JOIN tasks t ON t.id = a.task_id
    LEFT JOIN projects p ON p.id = t.project_id
        WHERE a.tenant_id = $1 AND a.approver_id = $2 AND a.status = 'pending'
          AND (a.task_id IS NULL OR NOT EXISTS (SELECT 1 FROM rv WHERE rv.id = a.task_id))
          AND (t.id IS NULL OR (t.deleted_at IS NULL AND (p.id IS NULL OR (p.status <> 'archived' AND NOT p.is_demo))))
          -- «Отложить до…» в Фокусе (#4891): отложенное уходит из очереди до даты
          AND NOT EXISTS (SELECT 1 FROM focus_snoozes s WHERE s.user_id = $2 AND s.until > now() AND s.item_key = 'approval:' || a.id::text)
        LIMIT 500`,
      [tenantId, userId],
    );
    return rows.map((r) => ({
      key: r.kind === 'approval' ? `approval:${r.approval_id}` : `review:${r.task_id}`,
      kind: r.kind, taskId: r.task_id ?? null, approvalId: r.approval_id ?? null, title: r.title ?? '',
      projectId: r.project_id ?? null, projectName: r.project_name ?? null,
      assigneeId: r.assignee_id ?? null, assigneeName: r.assignee_name ?? null,
      since: new Date(r.since), deadlineAt: r.deadline_at ? new Date(r.deadline_at) : null, priority: r.priority ?? null,
    }));
  }

  /**
   * Очереди проверки всей команды по проверяющим (п. 2: «кто пробка»). Проверяющий —
   * то же правило, что в deciderSql: назначенный, иначе постановщик.
   */
  team(tenantId: string) {
    return this.db.many<{ decider_id: string; name: string; n: number; oldest: Date; people: number; projects: number; overdue: number; project_names: string[] }>(
      `SELECT COALESCE(t.reviewer_id, t.created_by)::text AS decider_id, u.full_name AS name, count(*)::int AS n,
              min(COALESCE(t.submitted_at, t.updated_at)) AS oldest,
              count(DISTINCT t.assignee_id)::int AS people, count(DISTINCT t.project_id)::int AS projects,
              count(*) FILTER (WHERE t.deadline_at < now())::int AS overdue,
              (array_agg(DISTINCT p.name))[1:3] AS project_names
         FROM tasks t
         JOIN projects p ON p.id = t.project_id AND p.status <> 'archived' AND NOT p.is_demo
         JOIN users u ON u.id = COALESCE(t.reviewer_id, t.created_by) AND u.is_active
        WHERE t.tenant_id = $1 AND ${reviewTaskWhere('t')}
          AND (t.assignee_id IS NULL OR t.assignee_id <> COALESCE(t.reviewer_id, t.created_by))
        GROUP BY 1, 2
        ORDER BY n DESC`,
      [tenantId],
    );
  }

  /** У всей команды на проверке — связанное число в паспорте (п. 3). */
  async teamTotal(tenantId: string): Promise<number> {
    const r = await this.db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM tasks t
         JOIN projects p ON p.id = t.project_id AND p.status <> 'archived' AND NOT p.is_demo
        WHERE t.tenant_id = $1 AND ${reviewTaskWhere('t')}`,
      [tenantId],
    );
    return r?.n ?? 0;
  }
}
