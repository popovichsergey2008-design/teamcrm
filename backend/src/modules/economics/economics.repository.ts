import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DbService } from '../../database/db.service';
import { RateVersion, TimeLogInput } from './cost.calculator';

export interface ProjectPnl {
  projectId: string;
  budget: number | null;
  costActual: number;
  marginActual: number | null;
  marginThreshold: number | null;
  dealId: string | null;
  plannedMargin: number | null;
}

@Injectable()
export class EconomicsRepository {
  constructor(private readonly db: DbService) {}

  async getTaskProject(tenantId: string, taskId: string): Promise<{ project_id: string } | null> {
    return this.db.one(`SELECT project_id FROM tasks WHERE tenant_id=$1 AND id=$2`, [tenantId, taskId]);
  }

  async timeLogsForTask(tenantId: string, taskId: string): Promise<TimeLogInput[]> {
    const rows = await this.db.many<{ user_id: string; timestamp_start: Date; timestamp_end: Date | null }>(
      `SELECT user_id, timestamp_start, timestamp_end FROM time_logs
        WHERE tenant_id=$1 AND task_id=$2`,
      [tenantId, taskId],
    );
    return rows.map((r) => ({ userId: r.user_id, start: r.timestamp_start, end: r.timestamp_end }));
  }

  async ratesForUsers(tenantId: string, userIds: string[]): Promise<RateVersion[]> {
    if (userIds.length === 0) return [];
    const rows = await this.db.many<{
      user_id: string;
      hourly_rate: string;
      effective_from: Date;
      effective_to: Date | null;
    }>(
      `SELECT user_id, hourly_rate, effective_from, effective_to FROM rates
        WHERE tenant_id=$1 AND user_id = ANY($2::bigint[])`,
      [tenantId, userIds],
    );
    return rows.map((r) => ({
      userId: r.user_id,
      hourlyRate: Number(r.hourly_rate),
      effectiveFrom: r.effective_from,
      effectiveTo: r.effective_to,
    }));
  }

  /** id задач проекта, по которым есть трекинг данного пользователя (для смены ставки). */
  async taskIdsByUser(tenantId: string, userId: string): Promise<string[]> {
    const rows = await this.db.many<{ task_id: string }>(
      `SELECT DISTINCT task_id FROM time_logs WHERE tenant_id=$1 AND user_id=$2`,
      [tenantId, userId],
    );
    return rows.map((r) => r.task_id);
  }

  async taskIdsByProject(tenantId: string, projectId: string): Promise<string[]> {
    const rows = await this.db.many<{ id: string }>(
      `SELECT id FROM tasks WHERE tenant_id=$1 AND project_id=$2`,
      [tenantId, projectId],
    );
    return rows.map((r) => r.id);
  }

  /** Задачи с открытым таймером (для догоняющего тика). */
  async tasksWithOpenTimers(): Promise<Array<{ tenant_id: string; task_id: string }>> {
    return this.db.many(
      `SELECT DISTINCT tenant_id, task_id FROM time_logs WHERE timestamp_end IS NULL`,
    );
  }

  async setTaskCost(client: PoolClient, tenantId: string, taskId: string, cost: number) {
    await client.query(
      `UPDATE tasks SET cost_current=$3, updated_at=now() WHERE tenant_id=$1 AND id=$2`,
      [tenantId, taskId, cost.toFixed(2)],
    );
  }

  /** Пересчёт денормализованных P&L проекта в транзакции. Возвращает свежие значения. */
  async recomputeProjectAggregate(
    client: PoolClient,
    tenantId: string,
    projectId: string,
  ): Promise<ProjectPnl> {
    const proj = (
      await client.query<{
        budget: string | null;
        margin_alert_threshold: string | null;
        deal_id: string | null;
        default_margin_threshold: string;
        planned_margin: string | null;
      }>(
        `SELECT p.budget, p.margin_alert_threshold, p.deal_id,
                t.default_margin_threshold,
                d.planned_margin
           FROM projects p
           JOIN tenants t ON t.id = p.tenant_id
           LEFT JOIN deals d ON d.id = p.deal_id
          WHERE p.tenant_id=$1 AND p.id=$2`,
        [tenantId, projectId],
      )
    ).rows[0];

    // Себестоимость = живые задачи ПЛЮС удалённые: их часы уже оплачены людям,
    // и исчезновение задачи с доски не должно менять P&L задним числом.
    const sum = (
      await client.query<{ cost: string }>(
        `SELECT (SELECT COALESCE(SUM(cost_current),0) FROM tasks WHERE tenant_id=$1 AND project_id=$2)
              + (SELECT COALESCE(SUM(cost),0) FROM deleted_task_costs WHERE tenant_id=$1 AND project_id=$2)
              AS cost`,
        [tenantId, projectId],
      )
    ).rows[0];

    const budget = proj.budget !== null ? Number(proj.budget) : null;
    const costActual = Number(sum.cost);
    const marginActual =
      budget === null || budget === 0 ? null : Math.round(((budget - costActual) / budget) * 10000) / 100;
    const threshold =
      proj.margin_alert_threshold !== null
        ? Number(proj.margin_alert_threshold)
        : Number(proj.default_margin_threshold);

    await client.query(
      `UPDATE projects
          SET cost_actual=$3, margin_actual=$4, economics_recomputed_at=now()
        WHERE tenant_id=$1 AND id=$2`,
      [tenantId, projectId, costActual.toFixed(2), marginActual === null ? null : marginActual.toFixed(2)],
    );

    return {
      projectId,
      budget,
      costActual,
      marginActual,
      marginThreshold: threshold,
      dealId: proj.deal_id,
      plannedMargin: proj.planned_margin !== null ? Number(proj.planned_margin) : null,
    };
  }

  /** idempotent-raise: вставка активного алерта; конфликт по частичному индексу = уже активен. */
  async raiseMarginAlert(
    client: PoolClient,
    tenantId: string,
    projectId: string,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    const res = await client.query(
      `INSERT INTO alerts (tenant_id, project_id, type, severity, payload)
       VALUES ($1,$2,'margin_below_threshold','warning',$3::jsonb)
       ON CONFLICT (tenant_id, project_id, type) WHERE resolved_at IS NULL DO NOTHING
       RETURNING id`,
      [tenantId, projectId, JSON.stringify(payload)],
    );
    return (res.rowCount ?? 0) > 0; // true = новый алерт поднят
  }

  async resolveMarginAlert(client: PoolClient, tenantId: string, projectId: string): Promise<boolean> {
    const res = await client.query(
      `UPDATE alerts SET resolved_at=now()
        WHERE tenant_id=$1 AND project_id=$2 AND type='margin_below_threshold' AND resolved_at IS NULL`,
      [tenantId, projectId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async activeAlerts(tenantId: string) {
    return this.db.many(
      `SELECT id, project_id, task_id, type, severity, payload, raised_at
         FROM alerts WHERE tenant_id=$1 AND resolved_at IS NULL ORDER BY raised_at DESC`,
      [tenantId],
    );
  }

  /** Все time_logs проекта (для таймлайна дашборда). */
  async projectTimeLogs(
    tenantId: string,
    projectId: string,
  ): Promise<Array<{ userId: string; start: Date; end: Date | null }>> {
    const rows = await this.db.many<{ user_id: string; timestamp_start: Date; timestamp_end: Date | null }>(
      `SELECT tl.user_id, tl.timestamp_start, tl.timestamp_end
         FROM time_logs tl
        WHERE tl.tenant_id=$1 AND tl.task_id IN (SELECT id FROM tasks WHERE tenant_id=$1 AND project_id=$2)
        UNION ALL
       SELECT d.user_id, d.timestamp_start, d.timestamp_end
         FROM deleted_time_logs d
        WHERE d.tenant_id=$1 AND d.project_id=$2`,
      [tenantId, projectId],
    );
    return rows.map((r) => ({ userId: r.user_id, start: r.timestamp_start, end: r.timestamp_end }));
  }

  async getTaskCost(tenantId: string, taskId: string): Promise<{ id: string; cost_current: string } | null> {
    return this.db.one(`SELECT id, cost_current FROM tasks WHERE tenant_id=$1 AND id=$2`, [tenantId, taskId]);
  }

  // ── единый «cost of work»: часы (time_logs) + токены ИИ-агента (agent_runs) ──
  async taskHours(tenantId: string, taskId: string): Promise<number> {
    const r = await this.db.one<{ hours: string }>(
      `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (timestamp_end - timestamp_start))),0)/3600.0 AS hours
         FROM time_logs WHERE tenant_id=$1 AND task_id=$2 AND timestamp_end IS NOT NULL`,
      [tenantId, taskId],
    );
    return Number(r?.hours ?? 0);
  }
  async projectHours(tenantId: string, projectId: string): Promise<number> {
    // и здесь удалённые задачи считаются наравне с живыми: работа была сделана,
    // а «стоимость работы» без неё показывала бы проект дешевле, чем он есть
    const r = await this.db.one<{ hours: string }>(
      `SELECT ((SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (timestamp_end - timestamp_start))),0)
                 FROM time_logs
                WHERE tenant_id=$1 AND timestamp_end IS NOT NULL
                  AND task_id IN (SELECT id FROM tasks WHERE tenant_id=$1 AND project_id=$2))
            + (SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (timestamp_end - timestamp_start))),0)
                 FROM deleted_time_logs
                WHERE tenant_id=$1 AND project_id=$2 AND timestamp_end IS NOT NULL)
            ) / 3600.0 AS hours`,
      [tenantId, projectId],
    );
    return Number(r?.hours ?? 0);
  }
  /** Расход ИИ-агента, привязанный к задаче/проекту (agent_runs). Только успешные запуски. */
  async taskAgentAi(tenantId: string, taskId: string): Promise<{ tokens: number; runs: number }> {
    const r = await this.db.one<{ tokens: string; runs: string }>(
      `SELECT COALESCE(SUM(input_tokens+output_tokens),0)::int AS tokens, count(*)::int AS runs
         FROM agent_runs WHERE tenant_id=$1 AND task_id=$2 AND status IN ('done','accepted')`,
      [tenantId, taskId],
    );
    return { tokens: Number(r?.tokens ?? 0), runs: Number(r?.runs ?? 0) };
  }
  async projectAgentAi(tenantId: string, projectId: string): Promise<{ tokens: number; runs: number }> {
    const r = await this.db.one<{ tokens: string; runs: string }>(
      `SELECT COALESCE(SUM(input_tokens+output_tokens),0)::int AS tokens, count(*)::int AS runs
         FROM agent_runs WHERE tenant_id=$1 AND status IN ('done','accepted')
          AND task_id IN (SELECT id FROM tasks WHERE tenant_id=$1 AND project_id=$2)`,
      [tenantId, projectId],
    );
    return { tokens: Number(r?.tokens ?? 0), runs: Number(r?.runs ?? 0) };
  }

  async getProjectPnlRow(tenantId: string, projectId: string) {
    return this.db.one(
      `SELECT p.id, p.name, p.budget, p.cost_actual, p.margin_actual, p.deal_id,
              p.economics_recomputed_at, d.planned_margin
         FROM projects p LEFT JOIN deals d ON d.id=p.deal_id
        WHERE p.tenant_id=$1 AND p.id=$2`,
      [tenantId, projectId],
    );
  }

  async setMarginThreshold(tenantId: string, projectId: string, value: number): Promise<boolean> {
    const res = await this.db.query(
      `UPDATE projects SET margin_alert_threshold=$3 WHERE tenant_id=$1 AND id=$2`,
      [tenantId, projectId, value],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
