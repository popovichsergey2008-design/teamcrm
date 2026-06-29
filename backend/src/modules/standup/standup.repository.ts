import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface SubmissionRow {
  id: string;
  tenant_id: string;
  user_id: string;
  telegram_message_id: string;
  status: string;
  audio_file_ref: string | null;
  transcript_raw: string | null;
  transcript_masked: string | null;
  parsed_json: any;
  confidence: string | null;
  error_code: string | null;
  created_at: Date;
  applied_at: Date | null;
}

@Injectable()
export class StandupRepository {
  constructor(private readonly db: DbService) {}

  /** Дедуп по telegram_message_id: повторная доставка не создаёт второй сабмишен. */
  async create(
    tenantId: string,
    userId: string,
    messageId: string,
    audioRef: string | null,
  ): Promise<SubmissionRow | null> {
    return this.db.one<SubmissionRow>(
      `INSERT INTO standup_submissions (tenant_id, user_id, telegram_message_id, status, audio_file_ref)
       VALUES ($1,$2,$3,'received',$4)
       ON CONFLICT (telegram_message_id) DO NOTHING
       RETURNING *`,
      [tenantId, userId, messageId, audioRef],
    );
  }

  get(tenantId: string, id: string): Promise<SubmissionRow | null> {
    return this.db.one<SubmissionRow>(
      `SELECT * FROM standup_submissions WHERE tenant_id=$1 AND id=$2`,
      [tenantId, id],
    );
  }

  list(tenantId: string): Promise<SubmissionRow[]> {
    return this.db.many<SubmissionRow>(
      `SELECT * FROM standup_submissions WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [tenantId],
    );
  }

  async update(id: string, patch: Partial<SubmissionRow>): Promise<SubmissionRow> {
    const fields: string[] = [];
    const vals: any[] = [];
    let i = 1;
    for (const [k, v] of Object.entries(patch)) {
      fields.push(`${k} = $${i++}`);
      vals.push(k === 'parsed_json' ? JSON.stringify(v) : v);
    }
    vals.push(id);
    return this.db.one<SubmissionRow>(
      `UPDATE standup_submissions SET ${fields.join(', ')} WHERE id=$${i} RETURNING *`,
      vals,
    ) as Promise<SubmissionRow>;
  }

  /**
   * Резервирует слот действия (idempotent по (submission, index)).
   * @returns true если слот зарезервирован сейчас (нужно выполнить эффект),
   *          false если уже существует (эффект уже применён — пропустить).
   */
  async reserveAction(
    tenantId: string,
    submissionId: string,
    index: number,
    kind: string,
  ): Promise<boolean> {
    const res = await this.db.query(
      `INSERT INTO standup_actions (tenant_id, submission_id, action_index, kind, result)
       VALUES ($1,$2,$3,$4,'pending')
       ON CONFLICT (submission_id, action_index) DO NOTHING`,
      [tenantId, submissionId, index, kind],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async updateAction(
    submissionId: string,
    index: number,
    fields: { taskId?: string | null; result: string; timeLogId?: string | null; detail?: unknown },
  ): Promise<void> {
    await this.db.query(
      `UPDATE standup_actions
          SET task_id=$3, result=$4, applied_time_log_id=$5, detail=$6::jsonb
        WHERE submission_id=$1 AND action_index=$2`,
      [submissionId, index, fields.taskId ?? null, fields.result, fields.timeLogId ?? null, JSON.stringify(fields.detail ?? {})],
    );
  }

  appliedTimeLogIds(submissionId: string): Promise<Array<{ applied_time_log_id: string | null; task_id: string | null; detail: any }>> {
    return this.db.many(
      `SELECT applied_time_log_id, task_id, detail FROM standup_actions WHERE submission_id=$1`,
      [submissionId],
    );
  }

  async deleteTimeLog(tenantId: string, timeLogId: string): Promise<void> {
    await this.db.query(`DELETE FROM time_logs WHERE tenant_id=$1 AND id=$2`, [tenantId, timeLogId]);
  }

  actions(submissionId: string) {
    return this.db.many(
      `SELECT * FROM standup_actions WHERE submission_id=$1 ORDER BY action_index`,
      [submissionId],
    );
  }

  /** Поднять алерт блокера (idempotent по project+type через partial unique). */
  async raiseBlockerAlert(tenantId: string, projectId: string, taskId: string, detail: unknown) {
    await this.db.query(
      `INSERT INTO alerts (tenant_id, project_id, task_id, type, severity, payload)
       VALUES ($1,$2,$3,'task_blocked','warning',$4::jsonb)
       ON CONFLICT (tenant_id, project_id, type) WHERE resolved_at IS NULL DO NOTHING`,
      [tenantId, projectId, taskId, JSON.stringify(detail)],
    );
  }

  async resolveBlockerAlert(tenantId: string, projectId: string): Promise<void> {
    await this.db.query(
      `UPDATE alerts SET resolved_at=now()
        WHERE tenant_id=$1 AND project_id=$2 AND type='task_blocked' AND resolved_at IS NULL`,
      [tenantId, projectId],
    );
  }

  tenantAutoApply(tenantId: string): Promise<{ standup_auto_apply: boolean } | null> {
    return this.db.one(`SELECT standup_auto_apply FROM tenants WHERE id=$1`, [tenantId]);
  }

  listSchedules(tenantId: string) {
    return this.db.many(
      `SELECT * FROM standup_schedules WHERE tenant_id=$1 ORDER BY id`,
      [tenantId],
    );
  }

  createSchedule(input: {
    tenantId: string;
    cronExpr: string;
    timezone: string;
    promptText: string;
    targetRole: string | null;
  }) {
    return this.db.one(
      `INSERT INTO standup_schedules (tenant_id, cron_expr, timezone, prompt_text, target_role)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [input.tenantId, input.cronExpr, input.timezone, input.promptText, input.targetRole],
    );
  }
}
