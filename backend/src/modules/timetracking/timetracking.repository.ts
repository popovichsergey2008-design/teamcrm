import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface TimeLogRow {
  id: string;
  tenant_id: string;
  task_id: string;
  user_id: string;
  timestamp_start: Date;
  timestamp_end: Date | null;
}

@Injectable()
export class TimeTrackingRepository {
  constructor(private readonly db: DbService) {}

  taskProject(tenantId: string, taskId: string): Promise<{ project_id: string } | null> {
    return this.db.one(`SELECT project_id FROM tasks WHERE tenant_id=$1 AND id=$2`, [tenantId, taskId]);
  }

  activeTimer(tenantId: string, userId: string): Promise<TimeLogRow | null> {
    return this.db.one<TimeLogRow>(
      `SELECT * FROM time_logs WHERE tenant_id=$1 AND user_id=$2 AND timestamp_end IS NULL`,
      [tenantId, userId],
    );
  }

  /**
   * Старт: атомарно закрывает открытый таймер пользователя (если есть) и открывает новый.
   * Инвариант одного активного таймера гарантируется частичным unique-индексом.
   */
  async start(
    tenantId: string,
    userId: string,
    taskId: string,
  ): Promise<{ started: TimeLogRow; closed: TimeLogRow | null }> {
    return this.db.withTransaction(async (client) => {
      const closedRes = await client.query<TimeLogRow>(
        `UPDATE time_logs SET timestamp_end=now()
          WHERE tenant_id=$1 AND user_id=$2 AND timestamp_end IS NULL
          RETURNING *`,
        [tenantId, userId],
      );
      const startedRes = await client.query<TimeLogRow>(
        `INSERT INTO time_logs (tenant_id, task_id, user_id, timestamp_start)
         VALUES ($1,$2,$3, now()) RETURNING *`,
        [tenantId, taskId, userId],
      );
      return { started: startedRes.rows[0], closed: closedRes.rows[0] ?? null };
    });
  }

  /** Стоп: закрывает открытый таймер пользователя на данной задаче. */
  async stop(tenantId: string, userId: string, taskId: string): Promise<TimeLogRow | null> {
    return this.db.one<TimeLogRow>(
      `UPDATE time_logs SET timestamp_end=now()
        WHERE tenant_id=$1 AND user_id=$2 AND task_id=$3 AND timestamp_end IS NULL
        RETURNING *`,
      [tenantId, userId, taskId],
    );
  }
}
