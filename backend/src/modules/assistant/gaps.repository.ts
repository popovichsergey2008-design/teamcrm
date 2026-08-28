import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { Worker } from './gap-rules';

export interface GapTask {
  id: string;
  title: string;
  project_id: string;
  project_name: string;
  estimate_hours: number | null;
  /** Медиана дней «создана → закрыта» по этому проекту: по ней предлагается срок. */
  median_days: number | null;
  created_at: Date;
}

/**
 * Задачи с пустыми полями и всё, что нужно, чтобы предложить их заполнить.
 *
 * Запросы держим здесь, а решения — в `gap-rules`: кого назначить и на когда, видно
 * из цифр, а цифры честнее считать в базе, чем таскать в приложение всю историю задач.
 */
@Injectable()
export class GapsRepository {
  constructor(private readonly db: DbService) {}

  /** Ничьи задачи. Отказы («не этой») исключены здесь же — иначе они вернутся завтра. */
  withoutAssignee(tenantId: string, limit: number): Promise<GapTask[]> {
    return this.db.many<GapTask>(
      `SELECT t.id::text, t.title, t.project_id::text, p.name AS project_name,
              t.estimate_hours, NULL::numeric AS median_days, t.created_at
         FROM tasks t
         JOIN projects p ON p.id = t.project_id AND p.status <> 'archived'
    LEFT JOIN assistant_gap_skips s
           ON s.tenant_id = t.tenant_id AND s.task_id = t.id AND s.kind = 'assignee'
        WHERE t.tenant_id = $1 AND t.closed_at IS NULL
          AND t.assignee_id IS NULL AND s.task_id IS NULL
        ORDER BY t.created_at
        LIMIT $2`,
      [tenantId, limit],
    );
  }

  /**
   * Задачи без срока. Медиану закрытия проекта считаем тем же запросом: без неё
   * предложение свелось бы к «конец недели» для всего подряд.
   */
  withoutDeadline(tenantId: string, limit: number): Promise<GapTask[]> {
    return this.db.many<GapTask>(
      `WITH speed AS (
         SELECT project_id,
                percentile_cont(0.5) WITHIN GROUP (
                  ORDER BY EXTRACT(EPOCH FROM (closed_at - created_at)) / 86400
                ) AS median_days
           FROM tasks
          WHERE tenant_id = $1 AND closed_at IS NOT NULL
          GROUP BY project_id
       )
       SELECT t.id::text, t.title, t.project_id::text, p.name AS project_name,
              t.estimate_hours, sp.median_days, t.created_at
         FROM tasks t
         JOIN projects p ON p.id = t.project_id AND p.status <> 'archived'
    LEFT JOIN speed sp ON sp.project_id = t.project_id
    LEFT JOIN assistant_gap_skips s
           ON s.tenant_id = t.tenant_id AND s.task_id = t.id AND s.kind = 'deadline'
        WHERE t.tenant_id = $1 AND t.closed_at IS NULL
          AND t.deadline_at IS NULL AND s.task_id IS NULL
        ORDER BY t.created_at
        LIMIT $2`,
      [tenantId, limit],
    );
  }

  /**
   * Кто на что способен в этом проекте: закрытые задачи проекта и текущая загрузка.
   *
   * Клиентов и уволенных здесь нет: предлагать работу тому, кто её не увидит, — способ
   * потерять задачу молча.
   */
  workers(tenantId: string, projectId: string): Promise<Worker[]> {
    return this.db.many<Worker>(
      `SELECT u.id::text AS "userId", u.full_name AS "fullName",
              COUNT(*) FILTER (WHERE d.id IS NOT NULL)::int AS "doneInProject",
              COUNT(*) FILTER (WHERE o.id IS NOT NULL)::int AS "openTasks"
         FROM users u
    LEFT JOIN tasks d ON d.tenant_id = u.tenant_id AND d.assignee_id = u.id
                     AND d.project_id = $2 AND d.closed_at IS NOT NULL
    LEFT JOIN tasks o ON o.tenant_id = u.tenant_id AND o.assignee_id = u.id
                     AND o.closed_at IS NULL
        WHERE u.tenant_id = $1 AND u.is_active AND u.role <> 'client'
        GROUP BY u.id, u.full_name`,
      [tenantId, projectId],
    );
  }

  async skip(tenantId: string, taskId: string, kind: 'assignee' | 'deadline', actorId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO assistant_gap_skips (tenant_id, task_id, kind, actor_id)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [tenantId, taskId, kind, actorId],
    );
  }

  /** Сколько дыр всего — цифра нужна в сводке и в панели, а списки грузятся по частям. */
  async counts(tenantId: string): Promise<{ noAssignee: number; noDeadline: number }> {
    const row = await this.db.one<{ no_assignee: string; no_deadline: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE t.assignee_id IS NULL AND sa.task_id IS NULL) AS no_assignee,
         COUNT(*) FILTER (WHERE t.deadline_at IS NULL AND sd.task_id IS NULL) AS no_deadline
         FROM tasks t
         JOIN projects p ON p.id = t.project_id AND p.status <> 'archived'
    LEFT JOIN assistant_gap_skips sa
           ON sa.tenant_id = t.tenant_id AND sa.task_id = t.id AND sa.kind = 'assignee'
    LEFT JOIN assistant_gap_skips sd
           ON sd.tenant_id = t.tenant_id AND sd.task_id = t.id AND sd.kind = 'deadline'
        WHERE t.tenant_id = $1 AND t.closed_at IS NULL`,
      [tenantId],
    );
    return { noAssignee: Number(row?.no_assignee ?? 0), noDeadline: Number(row?.no_deadline ?? 0) };
  }
}
