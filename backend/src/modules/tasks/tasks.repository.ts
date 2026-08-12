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
  created_by: string | null;
  status: string;
  is_blocked: boolean;
  cost_current: string;
  priority: string;
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

  /**
   * Сквозная выборка задач по всем проектам организации — для вкладок «Мои» и «Порученные».
   * scope=mine — я исполнитель; scope=delegated — я руководитель, а исполнитель кто-то другой
   * (свои же задачи не дублируются между вкладками). Архивные проекты не показываем.
   */
  listForUser(
    tenantId: string,
    userId: string,
    scope: 'mine' | 'delegated',
    includeClosed: boolean,
  ): Promise<(TaskRow & { project_name: string; column_name: string; assignee_name: string | null; manager_name: string | null })[]> {
    const scopeSql = scope === 'mine'
      ? `t.assignee_id = $2`
      : `t.created_by = $2 AND (t.assignee_id IS NULL OR t.assignee_id <> $2)`;
    return this.db.many(
      `SELECT t.*, p.name AS project_name, bc.name AS column_name,
              ua.full_name AS assignee_name, um.full_name AS manager_name
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
         JOIN board_columns bc ON bc.id = t.column_id
         LEFT JOIN users ua ON ua.id = t.assignee_id
         LEFT JOIN users um ON um.id = t.created_by
        WHERE t.tenant_id = $1 AND ${scopeSql}
          AND p.status <> 'archived'
          AND ($3::boolean OR t.closed_at IS NULL)
        ORDER BY t.closed_at IS NOT NULL,
                 t.deadline_at IS NULL, t.deadline_at ASC,
                 CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                 t.created_at DESC`,
      [tenantId, userId, includeClosed],
    );
  }

  /** Флаг «задача передана ИИ-агенту» (виртуальный исполнитель). */
  async setAgentAssigned(tenantId: string, taskId: string, value: boolean): Promise<void> {
    await this.db.query(`UPDATE tasks SET agent_assigned=$3 WHERE tenant_id=$1 AND id=$2`, [tenantId, taskId, value]);
  }

  async create(input: {
    tenantId: string;
    projectId: string;
    columnId: string;
    status: string;
    title: string;
    description?: string | null;
    assigneeId?: string | null;
    createdBy?: string | null;
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
           (tenant_id, project_id, column_id, position, title, description, assignee_id, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          input.tenantId,
          input.projectId,
          input.columnId,
          position,
          input.title,
          input.description ?? null,
          input.assigneeId ?? null,
          input.status,
          input.createdBy ?? null,
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
      created_by: string | null;
      is_blocked: boolean;
      priority: string;
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

  async closeTask(tenantId: string, id: string): Promise<void> {
    await this.db.query(
      `UPDATE tasks SET closed_at = now(), updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND closed_at IS NULL`,
      [tenantId, id],
    );
  }

  async reopenTask(tenantId: string, id: string): Promise<void> {
    await this.db.query(
      `UPDATE tasks SET closed_at = NULL, updated_at = now() WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
  }

  async setBlocked(tenantId: string, id: string, blocked: boolean): Promise<TaskRow | null> {
    return this.db.one<TaskRow>(
      `UPDATE tasks SET is_blocked = $3, updated_at = now()
        WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [tenantId, id, blocked],
    );
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
