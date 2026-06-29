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
}
