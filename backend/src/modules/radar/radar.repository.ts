import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { REVIEW_COLUMN_NAMES } from '../tasks/task-columns';

export type ProjectHealth = {
  id: string;
  name: string;
  total: number;
  closed: number;
  overdue: number;
  /** ближайший срок среди открытых задач — по нему видно, горит ли проект */
  next_deadline: string | null;
};

export type PersonLoad = {
  user_id: string;
  full_name: string;
  open: number;
  overdue: number;
  due_today: number;
};

export type StuckTask = {
  id: string;
  project_id: string;
  title: string;
  project_name: string;
  column_name: string;
  updated_at: string;
  assignee_name: string | null;
};

@Injectable()
export class RadarRepository {
  constructor(private readonly db: DbService) {}

  /** Проекты: сколько задач всего, сколько закрыто, сколько горит. Архив не показываем. */
  projects(tenantId: string): Promise<ProjectHealth[]> {
    return this.db.many<ProjectHealth>(
      `SELECT p.id, p.name,
              COUNT(t.id)::int AS total,
              COUNT(t.id) FILTER (WHERE t.closed_at IS NOT NULL)::int AS closed,
              COUNT(t.id) FILTER (WHERE t.closed_at IS NULL AND t.deadline_at < now())::int AS overdue,
              MIN(t.deadline_at) FILTER (WHERE t.closed_at IS NULL) AS next_deadline
         FROM projects p
         LEFT JOIN tasks t ON t.project_id = p.id AND t.tenant_id = p.tenant_id
        WHERE p.tenant_id = $1 AND p.status <> 'archived'
        GROUP BY p.id, p.name
        ORDER BY overdue DESC, total DESC
        LIMIT 30`,
      [tenantId],
    );
  }

  /**
   * Загрузка людей: открытые задачи, просрочка и сроки на сегодня.
   *
   * Часы не считаем: оценка стоит далеко не у всех задач, и «14 часов работы»
   * из трёх заполненных полей — цифра, которой нельзя верить. Штук достаточно,
   * чтобы увидеть перекос.
   */
  people(tenantId: string, endOfDay: Date): Promise<PersonLoad[]> {
    return this.db.many<PersonLoad>(
      // Архивные проекты отсекаем ВНУТРИ подзапроса: условие в ON у LEFT JOIN
      // их бы не убрало — строка задачи осталась бы, просто без проекта.
      `SELECT u.id AS user_id, u.full_name,
              COUNT(t.id)::int AS open,
              COUNT(t.id) FILTER (WHERE t.deadline_at < now())::int AS overdue,
              COUNT(t.id) FILTER (WHERE t.deadline_at IS NOT NULL AND t.deadline_at <= $2)::int AS due_today
         FROM users u
         LEFT JOIN (
           SELECT t.id, t.assignee_id, t.deadline_at
             FROM tasks t
             JOIN projects p ON p.id = t.project_id
            WHERE t.tenant_id = $1 AND t.closed_at IS NULL AND p.status <> 'archived'
         ) t ON t.assignee_id = u.id
         JOIN roles r ON r.id = u.role_id
        WHERE u.tenant_id = $1 AND u.is_active AND r.code <> 'client'
        GROUP BY u.id, u.full_name
        ORDER BY open DESC, u.full_name`,
      [tenantId, endOfDay],
    );
  }

  /**
   * Узкие места: сданное лежит на проверке и не двигается.
   *
   * Считаем по updated_at, а не по истории переносов: любое изменение задачи его
   * сбрасывает, зато запрос дешёвый и не врёт в опасную сторону — задача, которую
   * трогали час назад, «зависшей» не покажется.
   */
  stuck(tenantId: string, hours: number): Promise<StuckTask[]> {
    return this.db.many<StuckTask>(
      `SELECT t.id, t.project_id, t.title, p.name AS project_name, bc.name AS column_name, t.updated_at,
              u.full_name AS assignee_name
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
         JOIN board_columns bc ON bc.id = t.column_id
         LEFT JOIN users u ON u.id = t.assignee_id
        WHERE t.tenant_id = $1
          AND t.closed_at IS NULL
          AND p.status <> 'archived'
          AND lower(bc.name) = ANY($3::text[])
          AND t.updated_at < now() - make_interval(hours => $2::int)
        ORDER BY t.updated_at ASC
        LIMIT 20`,
      [tenantId, hours, REVIEW_COLUMN_NAMES],
    );
  }

  /** Скорость: сколько задач закрыто за последние 7 дней и за предыдущие 7 — для сравнения. */
  velocity(tenantId: string): Promise<{ last7: number; prev7: number } | null> {
    return this.db.one(
      `SELECT
         COUNT(*) FILTER (WHERE closed_at >= now() - interval '7 days')::int AS last7,
         COUNT(*) FILTER (WHERE closed_at >= now() - interval '14 days'
                            AND closed_at <  now() - interval '7 days')::int AS prev7
         FROM tasks
        WHERE tenant_id = $1 AND closed_at IS NOT NULL`,
      [tenantId],
    );
  }
}
