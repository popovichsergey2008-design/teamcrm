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

  findColumnByName(tenantId: string, projectId: string, name: string): Promise<ColumnRow | null> {
    return this.db.one<ColumnRow>(
      `SELECT * FROM board_columns
        WHERE tenant_id = $1 AND project_id = $2 AND lower(name) = lower($3)`,
      [tenantId, projectId, name],
    );
  }
}
