import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DbService } from '../../database/db.service';

export interface ProjectRow {
  id: string;
  tenant_id: string;
  client_id: string | null;
  deal_id: string | null;
  name: string;
  budget: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export interface ColumnRow {
  id: string;
  tenant_id: string;
  project_id: string;
  name: string;
  position: number;
}

const DEFAULT_COLUMNS = ['To Do', 'In Progress', 'Done'];

@Injectable()
export class ProjectsRepository {
  constructor(private readonly db: DbService) {}

  list(tenantId: string): Promise<ProjectRow[]> {
    return this.db.many<ProjectRow>(
      `SELECT * FROM projects WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
  }

  findById(tenantId: string, id: string): Promise<ProjectRow | null> {
    return this.db.one<ProjectRow>(
      `SELECT * FROM projects WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
  }

  /** Создаёт проект и набор колонок доски по умолчанию в одной транзакции. */
  async create(input: {
    tenantId: string;
    name: string;
    clientId?: string | null;
    budget?: number | null;
  }): Promise<ProjectRow> {
    return this.db.withTransaction(async (client) => {
      const proj = await client.query<ProjectRow>(
        `INSERT INTO projects (tenant_id, name, client_id, budget)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [input.tenantId, input.name, input.clientId ?? null, input.budget ?? null],
      );
      const project = proj.rows[0];
      await this.seedColumns(client, input.tenantId, project.id);
      return project;
    });
  }

  private async seedColumns(client: PoolClient, tenantId: string, projectId: string) {
    for (let i = 0; i < DEFAULT_COLUMNS.length; i++) {
      await client.query(
        `INSERT INTO board_columns (tenant_id, project_id, name, position)
         VALUES ($1, $2, $3, $4)`,
        [tenantId, projectId, DEFAULT_COLUMNS[i], i],
      );
    }
  }

  listColumns(tenantId: string, projectId: string): Promise<ColumnRow[]> {
    return this.db.many<ColumnRow>(
      `SELECT * FROM board_columns WHERE tenant_id = $1 AND project_id = $2
        ORDER BY position ASC`,
      [tenantId, projectId],
    );
  }

  findColumn(tenantId: string, projectId: string, columnId: string): Promise<ColumnRow | null> {
    return this.db.one<ColumnRow>(
      `SELECT * FROM board_columns WHERE tenant_id = $1 AND project_id = $2 AND id = $3`,
      [tenantId, projectId, columnId],
    );
  }

  /**
   * Полное удаление проекта со всеми зависимостями в одной транзакции.
   * Дочерние данные задач удаляются, неключевые ссылки (deals/alerts/recommendations)
   * обнуляются — чтобы сохранить историю сделок/рекомендаций без проекта.
   */
  async deleteCascade(tenantId: string, projectId: string): Promise<void> {
    await this.db.withTransaction(async (client) => {
      const t: [string, string] = [tenantId, projectId];
      // подзапрос id задач проекта
      const taskSub = `SELECT id FROM tasks WHERE tenant_id = $1 AND project_id = $2`;
      // отвязать ссылки на time_logs/задачи в аудите стендапов
      await client.query(
        `UPDATE standup_actions SET task_id = NULL, applied_time_log_id = NULL
          WHERE tenant_id = $1 AND (task_id IN (${taskSub})
             OR applied_time_log_id IN (SELECT id FROM time_logs WHERE tenant_id = $1 AND task_id IN (${taskSub})))`,
        t,
      );
      // дочерние таблицы задач
      for (const tbl of [
        'task_activity',
        'task_watchers',
        'task_labels',
        'task_checklist_items',
        'task_attachments',
        'task_comments',
        'task_embeddings',
        'assignment_audit',
        'time_logs',
      ]) {
        await client.query(`DELETE FROM ${tbl} WHERE tenant_id = $1 AND task_id IN (${taskSub})`, t);
      }
      // обнулить мягкие ссылки на задачи
      await client.query(`UPDATE alerts SET task_id = NULL WHERE tenant_id = $1 AND task_id IN (${taskSub})`, t);
      await client.query(
        `UPDATE recommendations SET task_id = NULL WHERE tenant_id = $1 AND task_id IN (${taskSub})`,
        t,
      );
      // сами задачи и колонки
      await client.query(`DELETE FROM tasks WHERE tenant_id = $1 AND project_id = $2`, t);
      await client.query(`DELETE FROM board_columns WHERE tenant_id = $1 AND project_id = $2`, t);
      // обнулить ссылки на проект
      await client.query(`UPDATE deals SET project_id = NULL WHERE tenant_id = $1 AND project_id = $2`, t);
      await client.query(`UPDATE alerts SET project_id = NULL WHERE tenant_id = $1 AND project_id = $2`, t);
      await client.query(
        `UPDATE recommendations SET project_id = NULL WHERE tenant_id = $1 AND project_id = $2`,
        t,
      );
      await client.query(`DELETE FROM projects WHERE tenant_id = $1 AND id = $2`, t);
    });
  }

  countColumns(tenantId: string, projectId: string): Promise<number> {
    return this.db
      .one<{ n: string }>(
        `SELECT COUNT(*)::int AS n FROM board_columns WHERE tenant_id = $1 AND project_id = $2`,
        [tenantId, projectId],
      )
      .then((r) => Number(r?.n ?? 0));
  }

  /** Добавляет колонку в конец доски. */
  addColumn(tenantId: string, projectId: string, name: string): Promise<ColumnRow | null> {
    return this.db.one<ColumnRow>(
      `INSERT INTO board_columns (tenant_id, project_id, name, position)
       VALUES ($1, $2, $3,
         (SELECT COALESCE(MAX(position) + 1, 0) FROM board_columns WHERE tenant_id = $1 AND project_id = $2))
       RETURNING *`,
      [tenantId, projectId, name],
    );
  }

  renameColumn(tenantId: string, projectId: string, columnId: string, name: string): Promise<ColumnRow | null> {
    return this.db.one<ColumnRow>(
      `UPDATE board_columns SET name = $4 WHERE tenant_id = $1 AND project_id = $2 AND id = $3 RETURNING *`,
      [tenantId, projectId, columnId, name],
    );
  }

  /** Удаляет колонку; её задачи переносятся в крайнюю левую из оставшихся (без потери данных). */
  async deleteColumn(tenantId: string, projectId: string, columnId: string): Promise<void> {
    await this.db.withTransaction(async (client) => {
      const others = (
        await client.query<ColumnRow>(
          `SELECT * FROM board_columns WHERE tenant_id = $1 AND project_id = $2 AND id <> $3 ORDER BY position ASC`,
          [tenantId, projectId, columnId],
        )
      ).rows;
      const target = others[0];
      if (target) {
        const off = (
          await client.query<{ next: number }>(
            `SELECT COALESCE(MAX(position) + 1, 0) AS next FROM tasks WHERE tenant_id = $1 AND column_id = $2`,
            [tenantId, target.id],
          )
        ).rows[0].next;
        // переносим задачи в целевую колонку, переоткрываем (целевая — не Done)
        await client.query(
          `UPDATE tasks SET column_id = $3, position = position + $4, status = $5, closed_at = NULL, updated_at = now()
            WHERE tenant_id = $1 AND column_id = $2`,
          [tenantId, columnId, target.id, off, target.name],
        );
      }
      await client.query(
        `DELETE FROM board_columns WHERE tenant_id = $1 AND project_id = $2 AND id = $3`,
        [tenantId, projectId, columnId],
      );
      await this.renumberColumns(client, tenantId, projectId);
    });
  }

  /** Перемещает колонку влево/вправо (перестановка с соседом). */
  async moveColumn(tenantId: string, projectId: string, columnId: string, direction: 'left' | 'right'): Promise<void> {
    await this.db.withTransaction(async (client) => {
      const cols = (
        await client.query<ColumnRow>(
          `SELECT * FROM board_columns WHERE tenant_id = $1 AND project_id = $2 ORDER BY position ASC FOR UPDATE`,
          [tenantId, projectId],
        )
      ).rows;
      const idx = cols.findIndex((c) => String(c.id) === String(columnId));
      if (idx < 0) return;
      const swap = direction === 'left' ? idx - 1 : idx + 1;
      if (swap < 0 || swap >= cols.length) return;
      const order = cols.map((c) => c.id);
      [order[idx], order[swap]] = [order[swap], order[idx]];
      await this.applyColumnOrder(client, tenantId, order);
    });
  }

  /** Пересортировка позиций 0..n-1 по текущему порядку (двухпроходно — из-за UNIQUE(project_id,position)). */
  private async renumberColumns(client: PoolClient, tenantId: string, projectId: string): Promise<void> {
    const cols = (
      await client.query<{ id: string }>(
        `SELECT id FROM board_columns WHERE tenant_id = $1 AND project_id = $2 ORDER BY position ASC`,
        [tenantId, projectId],
      )
    ).rows;
    await this.applyColumnOrder(client, tenantId, cols.map((c) => c.id));
  }

  /** Двухпроходное проставление позиций (сначала +большой офсет, потом финальные индексы). */
  private async applyColumnOrder(client: PoolClient, tenantId: string, orderedIds: string[]): Promise<void> {
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query(`UPDATE board_columns SET position = $3 WHERE tenant_id = $1 AND id = $2`, [
        tenantId,
        orderedIds[i],
        i + 1000,
      ]);
    }
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query(`UPDATE board_columns SET position = $3 WHERE tenant_id = $1 AND id = $2`, [
        tenantId,
        orderedIds[i],
        i,
      ]);
    }
  }

  findColumnByName(tenantId: string, projectId: string, name: string): Promise<ColumnRow | null> {
    return this.db.one<ColumnRow>(
      `SELECT * FROM board_columns
        WHERE tenant_id = $1 AND project_id = $2 AND lower(name) = lower($3)`,
      [tenantId, projectId, name],
    );
  }
}
