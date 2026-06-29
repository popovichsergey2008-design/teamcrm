import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface ForecastTaskRow {
  id: string;
  project_id: string;
  assignee_id: string | null;
  estimate_hours: string | null;
  deadline_at: Date | null;
  predicted_finish_at: Date | null;
  risk_pct: string | null;
  risk_level: string | null;
}

@Injectable()
export class ForecastRepository {
  constructor(private readonly db: DbService) {}

  getTask(tenantId: string, taskId: string): Promise<ForecastTaskRow | null> {
    return this.db.one<ForecastTaskRow>(
      `SELECT id, project_id, assignee_id, estimate_hours, deadline_at,
              predicted_finish_at, risk_pct, risk_level
         FROM tasks WHERE tenant_id=$1 AND id=$2`,
      [tenantId, taskId],
    );
  }

  writeForecast(
    tenantId: string,
    taskId: string,
    predictedFinish: Date | null,
    riskPct: number | null,
    level: string,
  ) {
    return this.db.query(
      `UPDATE tasks SET predicted_finish_at=$3, risk_pct=$4, risk_level=$5, updated_at=now()
        WHERE tenant_id=$1 AND id=$2`,
      [tenantId, taskId, predictedFinish, riskPct, level],
    );
  }

  assign(tenantId: string, taskId: string, assigneeId: string) {
    return this.db.query(
      `UPDATE tasks SET assignee_id=$3, updated_at=now() WHERE tenant_id=$1 AND id=$2`,
      [tenantId, taskId, assigneeId],
    );
  }

  setEstimateDeadline(tenantId: string, taskId: string, estimate: number | null, deadline: string | null) {
    return this.db.query(
      `UPDATE tasks SET estimate_hours=COALESCE($3, estimate_hours),
                        deadline_at=COALESCE($4::timestamptz, deadline_at), updated_at=now()
        WHERE tenant_id=$1 AND id=$2`,
      [tenantId, taskId, estimate, deadline],
    );
  }

  async tenantRiskThreshold(tenantId: string): Promise<number> {
    const r = await this.db.one<{ risk_alert_threshold: string }>(
      `SELECT risk_alert_threshold FROM tenants WHERE id=$1`,
      [tenantId],
    );
    return Number(r?.risk_alert_threshold ?? 75);
  }

  auditAssignment(input: {
    tenantId: string;
    taskId: string;
    assigneeId: string;
    actorId: string;
    riskPct: number | null;
    overloadConfirmed: boolean;
  }) {
    return this.db.query(
      `INSERT INTO assignment_audit (tenant_id, task_id, assignee_id, actor_id, risk_pct, overload_confirmed)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [input.tenantId, input.taskId, input.assigneeId, input.actorId, input.riskPct, input.overloadConfirmed],
    );
  }
}
