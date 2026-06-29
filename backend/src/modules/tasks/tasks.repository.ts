import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface TaskRow {
  id: string;
  tenant_id: string;
  project_id: string;
  column_id: string;
  position: number;
  title: string;
  description: string | null;
  assignee_id: string | null;
  status: string;
  is_blocked: boolean;
  cost_current: string;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
}

@Injectable()
export class TasksRepository {
  constructor(private readonly db: DbService) {}

  findById(tenantId: string, id: string): Promise<TaskRow | null> {
    return this.db.one<TaskRow>(
      `SELECT * FROM tasks WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
  }

  listByProject(tenantId: string, projectId: string): Promise<TaskRow[]> {
    return this.db.many<TaskRow>(
      `SELECT * FROM tasks WHERE tenant_id = $1 AND project_id = $2
        ORDER BY column_id, position ASC`,
      [tenantId, projectId],
    );
  }

  async create(input: {
    tenantId: string;
    projectId: string;
    columnId: string;
    status: string;
    title: string;
    description?: string | null;
    assigneeId?: string | null;
  }): Promise<TaskRow> {
    return this.db.withTransaction(async (client) => {
      const posRes = await client.query<{ next: number }>(
        `SELECT COALESCE(MAX(position) + 1, 0) AS next FROM tasks
          WHERE tenant_id = $1 AND column_id = $2`,
        [input.tenantId, input.columnId],
      );
      const position = posRes.rows[0].next;
      const res = await client.query<TaskRow>(
        `INSERT INTO tasks
           (tenant_id, project_id, column_id, position, title, description, assignee_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          input.tenantId,
          input.projectId,
          input.columnId,
          position,
          input.title,
          input.description ?? null,
          input.assigneeId ?? null,
          input.status,
        ],
      );
      return res.rows[0];
    });
  }

  async update(
    tenantId: string,
    id: string,
    patch: Partial<{
      title: string;
      description: string | null;
      assignee_id: string | null;
      is_blocked: boolean;
    }>,
  ): Promise<TaskRow | null> {
    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      fields.push(`${key} = $${i++}`);
      values.push(value);
    }
    if (fields.length === 0) return this.findById(tenantId, id);
    fields.push(`updated_at = now()`);
    values.push(tenantId, id);
    const res = await this.db.one<TaskRow>(
      `UPDATE tasks SET ${fields.join(', ')}
        WHERE tenant_id = $${i++} AND id = $${i} RETURNING *`,
      values,
    );
    return res;
  }

  /** Перенос задачи: новая колонка + позиция, с пересортировкой соседей. */
  async move(
    tenantId: string,
    id: string,
    targetColumnId: string,
    targetPosition: number,
    newStatus: string,
  ): Promise<TaskRow> {
    return this.db.withTransaction(async (client) => {
      const cur = await client.query<TaskRow>(
        `SELECT * FROM tasks WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [tenantId, id],
      );
      const task = cur.rows[0];
      const fromCol = task.column_id;
      const fromPos = task.position;

      // вынуть из старой колонки: сдвинуть вниз тех, кто был после
      await client.query(
        `UPDATE tasks SET position = position - 1
          WHERE tenant_id = $1 AND column_id = $2 AND position > $3`,
        [tenantId, fromCol, fromPos],
      );
      // освободить место в целевой колонке
      await client.query(
        `UPDATE tasks SET position = position + 1
          WHERE tenant_id = $1 AND column_id = $2 AND position >= $3`,
        [tenantId, targetColumnId, targetPosition],
      );
      const res = await client.query<TaskRow>(
        `UPDATE tasks
            SET column_id = $3, position = $4, status = $5, updated_at = now()
          WHERE tenant_id = $1 AND id = $2 RETURNING *`,
        [tenantId, id, targetColumnId, targetPosition, newStatus],
      );
      return res.rows[0];
    });
  }
}
