import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { IndexPoint } from './pulse-index.rules';

/**
 * Величины индекса (#4890, п. 1) на моменты «сейчас» и «k недель назад».
 *
 * Прошлое восстанавливаем из фактов: закрытия и заведения — по датам задач, этап на
 * момент времени — по журналу переходов (ТЗ-32): последний переход до момента, иначе
 * исходный этап первого перехода после, иначе нынешний этап. Исполнителя на прошлый
 * момент журнал не хранит — берём нынешнего (задачи передают редко).
 */
@Injectable()
export class PulseIndexRepository {
  constructor(private readonly db: DbService) {}

  async points(tenantId: string, weeks: number[]): Promise<Map<number, IndexPoint>> {
    const rows = await this.db.many<any>(
      `WITH pts AS (SELECT k, now() - make_interval(days => 7 * k) AS at FROM unnest($2::int[]) AS k),
       tk AS (
         SELECT t.id, t.created_at, t.closed_at, t.deadline_at, t.assignee_id, t.column_id, t.approval_state, t.is_blocked
           FROM tasks t JOIN projects p ON p.id = t.project_id AND p.status <> 'archived' AND NOT p.is_demo
          WHERE t.tenant_id = $1 AND t.deleted_at IS NULL
            AND (t.closed_at IS NULL OR t.closed_at > now() - make_interval(days => 7 * (SELECT max(k) FROM pts) + 31))
       ),
       st AS (
         SELECT pts.k, pts.at, tk.id, tk.assignee_id, tk.deadline_at,
                CASE WHEN pts.k = 0 THEN task_effective_stage(tk.column_id, tk.approval_state, tk.closed_at, tk.is_blocked)
                ELSE COALESCE(
                  (SELECT s.to_stage FROM task_status_transitions s WHERE s.task_id = tk.id AND s.changed_at <= pts.at ORDER BY s.changed_at DESC LIMIT 1),
                  (SELECT s.from_stage FROM task_status_transitions s WHERE s.task_id = tk.id AND s.changed_at > pts.at ORDER BY s.changed_at ASC LIMIT 1),
                  task_effective_stage(tk.column_id, tk.approval_state, NULL, tk.is_blocked))
                END AS stage
           FROM pts JOIN tk ON tk.created_at <= pts.at AND (tk.closed_at IS NULL OR tk.closed_at > pts.at)
       )
       SELECT pts.k,
         (SELECT count(*) FROM tk WHERE tk.closed_at > pts.at - interval '7 days' AND tk.closed_at <= pts.at)::int AS closed7,
         (SELECT count(*) FROM tk WHERE tk.created_at > pts.at - interval '7 days' AND tk.created_at <= pts.at)::int AS created7,
         (SELECT count(*) FROM tk WHERE tk.closed_at > pts.at - interval '30 days' AND tk.closed_at <= pts.at)::int AS closed30,
         (SELECT count(*) FROM tk WHERE tk.created_at > pts.at - interval '30 days' AND tk.created_at <= pts.at)::int AS created30,
         (SELECT count(*) FROM st WHERE st.k = pts.k AND st.stage <> 'done')::int AS open,
         (SELECT count(*) FROM st WHERE st.k = pts.k AND st.stage <> 'done' AND st.deadline_at IS NOT NULL)::int AS with_deadline,
         (SELECT count(*) FROM st WHERE st.k = pts.k AND st.stage IN ('work', 'blocked') AND st.deadline_at < pts.at)::int AS overdue,
         (SELECT count(*) FROM st WHERE st.k = pts.k AND st.stage IN ('testing', 'review', 'approval'))::int AS review,
         (SELECT count(*) FROM st WHERE st.k = pts.k AND st.stage <> 'done' AND st.assignee_id IS NULL)::int AS no_assignee,
         (SELECT COALESCE(sum(GREATEST(0, x.n - 12)), 0) FROM (
            SELECT count(*) AS n FROM st WHERE st.k = pts.k AND st.stage IN ('work', 'blocked') AND st.assignee_id IS NOT NULL
             GROUP BY st.assignee_id) x)::int AS excess
         FROM pts ORDER BY pts.k`,
      [tenantId, weeks],
    );
    const out = new Map<number, IndexPoint>();
    for (const r of rows) {
      out.set(Number(r.k), {
        closed7: Number(r.closed7), created7: Number(r.created7), closed30: Number(r.closed30), created30: Number(r.created30),
        open: Number(r.open), withDeadline: Number(r.with_deadline), overdue: Number(r.overdue), review: Number(r.review),
        noAssignee: Number(r.no_assignee), excess: Number(r.excess),
      });
    }
    return out;
  }
}
