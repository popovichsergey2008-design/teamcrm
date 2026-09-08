import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface PositionRow {
  id: string;
  tenant_id: string;
  name: string;
  /** Должность, которой доверено публиковать новости компании (пресс-секретарь и т.п.). */
  can_post_news: boolean;
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

  /**
   * Право публиковать новости — на должности, а не на человеке.
   *
   * При смене пресс-секретаря право переезжает вместе с должностью, и не нужно
   * вспоминать, кому его когда-то выдали персонально.
   */
  setCanPostNews(tenantId: string, id: string, allowed: boolean) {
    return this.db.one<PositionRow>(
      `UPDATE positions SET can_post_news=$3 WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [tenantId, id, allowed],
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
