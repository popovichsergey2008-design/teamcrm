import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

@Injectable()
export class VelocityRepository {
  constructor(private readonly db: DbService) {}

  /** Закрытые задачи и затреканные часы пользователя за окно (источник Velocity). */
  async windowStats(
    tenantId: string,
    userId: string,
    from: Date,
    to: Date,
  ): Promise<{ closedTasks: number; trackedHours: number }> {
    const closed = await this.db.one<{ n: string }>(
      `SELECT COUNT(*) AS n FROM tasks
        WHERE tenant_id=$1 AND assignee_id=$2 AND closed_at IS NOT NULL
          AND closed_at >= $3 AND closed_at < $4`,
      [tenantId, userId, from, to],
    );
    const hours = await this.db.one<{ h: string }>(
      `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(timestamp_end, now()) - timestamp_start)) / 3600), 0) AS h
         FROM time_logs
        WHERE tenant_id=$1 AND user_id=$2 AND timestamp_start >= $3 AND timestamp_start < $4`,
      [tenantId, userId, from, to],
    );
    // точность 4 знака: короткие интервалы (доли часа) не должны схлопываться в 0
    return { closedTasks: Number(closed?.n ?? 0), trackedHours: Math.round(Number(hours?.h ?? 0) * 10000) / 10000 };
  }

  /** Дни отсутствий, пересекающие окно (нормировка ёмкости). */
  async absenceDays(tenantId: string, userId: string, from: Date, to: Date): Promise<number> {
    const r = await this.db.one<{ d: string }>(
      `SELECT COALESCE(SUM(
                GREATEST(0, (LEAST(to_date, $4::date) - GREATEST(from_date, $3::date)) + 1)
              ), 0) AS d
         FROM user_availability
        WHERE tenant_id=$1 AND user_id=$2 AND to_date >= $3::date AND from_date < $4::date`,
      [tenantId, userId, from, to],
    );
    return Number(r?.d ?? 0);
  }

  weeklyCapacity(tenantId: string, userId: string): Promise<{ weekly_capacity_hours: string } | null> {
    return this.db.one(`SELECT weekly_capacity_hours FROM users WHERE tenant_id=$1 AND id=$2`, [tenantId, userId]);
  }

  /** Текущая загрузка: суммарная оценка открытых задач исполнителя. */
  async openQueueHours(tenantId: string, userId: string, excludeTaskId?: string): Promise<number> {
    const r = await this.db.one<{ h: string }>(
      `SELECT COALESCE(SUM(estimate_hours), 0) AS h FROM tasks
        WHERE tenant_id=$1 AND assignee_id=$2 AND closed_at IS NULL
          AND ($3::bigint IS NULL OR id <> $3)`,
      [tenantId, userId, excludeTaskId ?? null],
    );
    return Math.round(Number(r?.h ?? 0) * 100) / 100;
  }

  upsertMetric(input: {
    tenantId: string;
    userId: string;
    from: Date;
    to: Date;
    closedTasks: number;
    trackedHours: number;
    velocity: number;
  }) {
    return this.db.query(
      `INSERT INTO velocity_metrics (tenant_id, user_id, window_from, window_to, closed_tasks, tracked_hours, velocity)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id, user_id, window_from, window_to)
       DO UPDATE SET closed_tasks=EXCLUDED.closed_tasks, tracked_hours=EXCLUDED.tracked_hours,
                     velocity=EXCLUDED.velocity, computed_at=now()`,
      [input.tenantId, input.userId, input.from, input.to, input.closedTasks, input.trackedHours, input.velocity],
    );
  }

  latestMetric(tenantId: string, userId: string) {
    return this.db.one(
      `SELECT * FROM velocity_metrics WHERE tenant_id=$1 AND user_id=$2 ORDER BY computed_at DESC LIMIT 1`,
      [tenantId, userId],
    );
  }

  listUserIds(tenantId: string): Promise<Array<{ id: string }>> {
    return this.db.many(`SELECT id FROM users WHERE tenant_id=$1 AND is_active=TRUE`, [tenantId]);
  }

  // availability
  addAvailability(tenantId: string, userId: string, kind: string, fromDate: string, toDate: string) {
    return this.db.one(
      `INSERT INTO user_availability (tenant_id, user_id, kind, from_date, to_date)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [tenantId, userId, kind, fromDate, toDate],
    );
  }
  listAvailability(tenantId: string, userId: string) {
    return this.db.many(
      `SELECT * FROM user_availability WHERE tenant_id=$1 AND user_id=$2 ORDER BY from_date DESC`,
      [tenantId, userId],
    );
  }

  async removeAvailability(tenantId: string, userId: string, id: string): Promise<void> {
    await this.db.query(
      `DELETE FROM user_availability WHERE tenant_id=$1 AND user_id=$2 AND id=$3`,
      [tenantId, userId, id],
    );
  }
}
