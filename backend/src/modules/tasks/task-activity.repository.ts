import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

/** Лента изменений задачи (activity log). Используется Tasks и TaskCard. */
@Injectable()
export class TaskActivityRepository {
  constructor(private readonly db: DbService) {}

  log(
    tenantId: string,
    taskId: string,
    actorId: string | null,
    kind: string,
    detail: Record<string, unknown> = {},
  ) {
    return this.db.query(
      `INSERT INTO task_activity (tenant_id, task_id, actor_id, kind, detail)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [tenantId, taskId, actorId, kind, JSON.stringify(detail)],
    );
  }

  list(tenantId: string, taskId: string) {
    return this.db.many(
      `SELECT a.id, a.actor_id, a.kind, a.detail, a.created_at, u.full_name AS actor_name
         FROM task_activity a LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.tenant_id=$1 AND a.task_id=$2 ORDER BY a.created_at DESC LIMIT 200`,
      [tenantId, taskId],
    );
  }
}
