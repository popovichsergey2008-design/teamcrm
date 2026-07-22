import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { ProjectRow } from '../projects/projects.repository';

export interface DealRow {
  id: string;
  tenant_id: string;
  client_id: string | null;
  title: string;
  stage: string;
  amount: string | null;
  planned_margin: string | null;
  project_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const DEFAULT_COLUMNS = ['Новые', 'В работе', 'На тестировании', 'Готово'];

@Injectable()
export class DealsRepository {
  constructor(private readonly db: DbService) {}

  list(tenantId: string): Promise<DealRow[]> {
    return this.db.many<DealRow>(
      `SELECT * FROM deals WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
  }

  findById(tenantId: string, id: string): Promise<DealRow | null> {
    return this.db.one<DealRow>(
      `SELECT * FROM deals WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
  }

  create(input: {
    tenantId: string;
    title: string;
    stage: string;
    clientId?: string | null;
    amount?: number | null;
    plannedMargin?: number | null;
  }): Promise<DealRow> {
    return this.db.one<DealRow>(
      `INSERT INTO deals (tenant_id, title, stage, client_id, amount, planned_margin)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        input.tenantId,
        input.title,
        input.stage,
        input.clientId ?? null,
        input.amount ?? null,
        input.plannedMargin ?? null,
      ],
    ) as Promise<DealRow>;
  }

  /**
   * Разворот сделки в проект (фича №5) — атомарно:
   * создаём project (budget = amount сделки), колонки доски, связываем deal.project_id.
   */
  async convert(tenantId: string, deal: DealRow): Promise<{ deal: DealRow; project: ProjectRow }> {
    return this.db.withTransaction(async (client) => {
      const projRes = await client.query<ProjectRow>(
        `INSERT INTO projects (tenant_id, client_id, deal_id, name, budget)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [tenantId, deal.client_id, deal.id, deal.title, deal.amount],
      );
      const project = projRes.rows[0];

      for (let i = 0; i < DEFAULT_COLUMNS.length; i++) {
        await client.query(
          `INSERT INTO board_columns (tenant_id, project_id, name, position)
           VALUES ($1,$2,$3,$4)`,
          [tenantId, project.id, DEFAULT_COLUMNS[i], i],
        );
      }

      const dealRes = await client.query<DealRow>(
        `UPDATE deals SET project_id = $3, stage = 'won', updated_at = now()
          WHERE tenant_id = $1 AND id = $2 RETURNING *`,
        [tenantId, deal.id, project.id],
      );
      return { deal: dealRes.rows[0], project };
    });
  }
}
