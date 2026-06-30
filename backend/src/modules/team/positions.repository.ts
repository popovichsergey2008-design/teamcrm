import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface PositionRow {
  id: string;
  tenant_id: string;
  name: string;
  created_at: Date;
}

@Injectable()
export class PositionsRepository {
  constructor(private readonly db: DbService) {}

  list(tenantId: string): Promise<PositionRow[]> {
    return this.db.many<PositionRow>(
      `SELECT * FROM positions WHERE tenant_id=$1 ORDER BY name`,
      [tenantId],
    );
  }

  create(tenantId: string, name: string): Promise<PositionRow> {
    return this.db.one<PositionRow>(
      `INSERT INTO positions (tenant_id, name) VALUES ($1,$2) RETURNING *`,
      [tenantId, name],
    ) as Promise<PositionRow>;
  }

  rename(tenantId: string, id: string, name: string) {
    return this.db.one<PositionRow>(
      `UPDATE positions SET name=$3 WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [tenantId, id, name],
    );
  }

  async remove(tenantId: string, id: string): Promise<void> {
    // снять должность с пользователей, затем удалить
    await this.db.query(`UPDATE users SET position_id=NULL WHERE tenant_id=$1 AND position_id=$2`, [tenantId, id]);
    await this.db.query(`DELETE FROM positions WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }

  exists(tenantId: string, id: string): Promise<{ id: string } | null> {
    return this.db.one(`SELECT id FROM positions WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }
}
