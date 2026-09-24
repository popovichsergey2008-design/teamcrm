import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { REVIEW_COLUMN_NAMES } from '../tasks/task-columns';

export type NavCountsRow = {
  decide: number;
  today: number;
  risks: number;
};

@Injectable()
export class NavRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Все счётчики одним запросом.
   *
   * Три отдельных запроса ради трёх чисел — это три похода в базу на каждый показ
   * панели, то есть на каждое переключение раздела. Скалярные подзапросы считаются
   * за один проход и по тем же индексам, что и списки задач.
   *
   * @param endOfDay конец сегодняшнего дня в часовом поясе пользователя (UTC-метка)
   * @param withRisks считать ли общий по организации счётчик просрочки (только руководителям)
   */
  counts(tenantId: string, userId: string, endOfDay: Date, withRisks: boolean): Promise<NavCountsRow | null> {
    return this.db.one<NavCountsRow>(
      `SELECT
         (SELECT COUNT(*) FROM tasks t
            JOIN projects p ON p.id = t.project_id
            JOIN board_columns bc ON bc.id = t.column_id
           WHERE t.tenant_id = $1 AND t.deleted_at IS NULL
             AND t.created_by = $2
             AND (t.assignee_id IS NULL OR t.assignee_id <> $2)
             AND t.closed_at IS NULL
             AND p.status <> 'archived'
             AND lower(bc.name) = ANY($4::text[]))::int AS decide,
         (SELECT COUNT(*) FROM tasks t
            JOIN projects p ON p.id = t.project_id
           WHERE t.tenant_id = $1 AND t.deleted_at IS NULL
             AND t.assignee_id = $2
             AND t.closed_at IS NULL
             AND p.status <> 'archived'
             AND t.deadline_at IS NOT NULL
             AND t.deadline_at <= $3)::int AS today,
         (CASE WHEN $5 THEN (
            SELECT COUNT(*) FROM tasks t
              JOIN projects p ON p.id = t.project_id
             WHERE t.tenant_id = $1 AND t.deleted_at IS NULL
               AND t.closed_at IS NULL
               AND p.status <> 'archived'
               AND t.deadline_at IS NOT NULL
               AND t.deadline_at < now())
          ELSE 0 END)::int AS risks`,
      [tenantId, userId, endOfDay, REVIEW_COLUMN_NAMES, withRisks],
    );
  }
}
