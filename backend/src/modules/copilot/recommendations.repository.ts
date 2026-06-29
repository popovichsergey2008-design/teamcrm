import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface RecommendationRow {
  id: string;
  tenant_id: string;
  type: string;
  project_id: string | null;
  task_id: string | null;
  is_financial: boolean;
  payload: any;
  status: string;
  created_at: Date;
  resolved_at: Date | null;
}

@Injectable()
export class RecommendationsRepository {
  constructor(private readonly db: DbService) {}

  create(input: {
    tenantId: string;
    type: string;
    projectId: string | null;
    taskId: string | null;
    isFinancial: boolean;
    payload: unknown;
  }): Promise<RecommendationRow> {
    return this.db.one<RecommendationRow>(
      `INSERT INTO recommendations (tenant_id, type, project_id, task_id, is_financial, payload)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
      [input.tenantId, input.type, input.projectId, input.taskId, input.isFinancial, JSON.stringify(input.payload)],
    ) as Promise<RecommendationRow>;
  }

  get(tenantId: string, id: string) {
    return this.db.one<RecommendationRow>(
      `SELECT * FROM recommendations WHERE tenant_id=$1 AND id=$2`,
      [tenantId, id],
    );
  }

  listActive(tenantId: string, includeFinancial: boolean) {
    return this.db.many<RecommendationRow>(
      `SELECT * FROM recommendations
        WHERE tenant_id=$1 AND status='pending' AND ($2 OR is_financial=FALSE)
        ORDER BY created_at DESC`,
      [tenantId, includeFinancial],
    );
  }

  setStatus(tenantId: string, id: string, status: string) {
    return this.db.query(
      `UPDATE recommendations SET status=$3, resolved_at=now() WHERE tenant_id=$1 AND id=$2`,
      [tenantId, id, status],
    );
  }

  async pendingExists(tenantId: string, type: string, taskId: string | null, projectId: string | null): Promise<boolean> {
    const r = await this.db.one<{ n: string }>(
      `SELECT COUNT(*) AS n FROM recommendations
        WHERE tenant_id=$1 AND type=$2 AND status='pending'
          AND task_id IS NOT DISTINCT FROM $3 AND project_id IS NOT DISTINCT FROM $4`,
      [tenantId, type, taskId, projectId],
    );
    return Number(r?.n ?? 0) > 0;
  }

  redAssignedTasks(tenantId: string): Promise<Array<{ id: string; project_id: string; assignee_id: string }>> {
    return this.db.many(
      `SELECT id, project_id, assignee_id FROM tasks
        WHERE tenant_id=$1 AND risk_level='red' AND assignee_id IS NOT NULL AND closed_at IS NULL`,
      [tenantId],
    );
  }

  activeMarginAlertProjects(tenantId: string): Promise<Array<{ project_id: string }>> {
    return this.db.many(
      `SELECT DISTINCT project_id FROM alerts
        WHERE tenant_id=$1 AND type='margin_below_threshold' AND resolved_at IS NULL AND project_id IS NOT NULL`,
      [tenantId],
    );
  }
}
