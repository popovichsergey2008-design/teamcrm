import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface AgentRunRow {
  id: string;
  tenant_id: string;
  task_id: string;
  kind: string;
  status: string;
  result: string | null;
  comment_id: string | null;
  citations: unknown;
  input_tokens: number;
  output_tokens: number;
  error: string | null;
  created_by: string;
  created_at: Date;
  finished_at: Date | null;
}

@Injectable()
export class AgentsRepository {
  constructor(private readonly db: DbService) {}

  createRun(tenantId: string, taskId: string, kind: string, createdBy: string): Promise<AgentRunRow> {
    return this.db.one<AgentRunRow>(
      `INSERT INTO agent_runs (tenant_id, task_id, kind, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
      [tenantId, taskId, kind, createdBy],
    ) as Promise<AgentRunRow>;
  }

  async finishRun(id: string, r: { result: string; commentId: string | null; citations: unknown; inputTokens: number; outputTokens: number }): Promise<void> {
    await this.db.query(
      `UPDATE agent_runs SET status='done', result=$2, comment_id=$3, citations=$4, input_tokens=$5, output_tokens=$6, finished_at=now() WHERE id=$1`,
      [id, r.result, r.commentId, JSON.stringify(r.citations ?? []), r.inputTokens, r.outputTokens],
    );
  }

  async failRun(id: string, error: string): Promise<void> {
    await this.db.query(`UPDATE agent_runs SET status='failed', error=$2, finished_at=now() WHERE id=$1`, [id, error.slice(0, 1000)]);
  }

  getRun(tenantId: string, id: string): Promise<AgentRunRow | null> {
    return this.db.one<AgentRunRow>(`SELECT * FROM agent_runs WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }

  async setOutcome(id: string, outcome: 'accepted' | 'rejected'): Promise<void> {
    await this.db.query(`UPDATE agent_runs SET status=$2 WHERE id=$1`, [id, outcome]);
  }

  /** Отказ агента (задача не автоматизируется): фиксируем результат-пояснение и статус. */
  async declineRun(id: string, note: string, commentId: string | null): Promise<void> {
    await this.db.query(
      `UPDATE agent_runs SET status='declined', result=$2, comment_id=$3, finished_at=now() WHERE id=$1`,
      [id, note, commentId],
    );
  }

  listForTask(tenantId: string, taskId: string) {
    return this.db.many(
      `SELECT id, kind, status, result, comment_id, citations, input_tokens, output_tokens, error, created_by, created_at, finished_at
         FROM agent_runs WHERE tenant_id=$1 AND task_id=$2 ORDER BY created_at DESC LIMIT 50`,
      [tenantId, taskId],
    );
  }

  /** Число запусков арендатора за последние N часов — для лимита (guard, день 3). */
  async countSince(tenantId: string, hours: number): Promise<number> {
    const row = await this.db.one<{ n: string }>(
      `SELECT count(*)::int AS n FROM agent_runs WHERE tenant_id=$1 AND created_at > now() - ($2 || ' hours')::interval`,
      [tenantId, hours],
    );
    return Number(row?.n ?? 0);
  }
}
