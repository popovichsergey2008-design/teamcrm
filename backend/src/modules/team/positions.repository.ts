import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface PositionRow {
  id: string;
  tenant_id: string;
  name: string;
  /** Должность, которой доверено публиковать новости компании (пресс-секретарь и т.п.). */
  can_post_news: boolean;
  /** #4615: уровень иерархии — ceo | head | deputy | specialist | intern. */
  level: string;
  sort_order: number;
  created_at: Date;
}

@Injectable()
export class PositionsRepository {
  constructor(private readonly db: DbService) {}

  list(tenantId: string): Promise<PositionRow[]> {
    return this.db.many<PositionRow>(
      `SELECT p.*, (SELECT count(*)::int FROM users u WHERE u.position_id = p.id AND u.is_active) AS holders
         FROM positions p WHERE p.tenant_id=$1 ORDER BY p.sort_order, p.name`,
      [tenantId],
    );
  }

  /** Новая должность — в конец списка. */
  create(tenantId: string, name: string, level = 'specialist'): Promise<PositionRow> {
    return this.db.one<PositionRow>(
      `INSERT INTO positions (tenant_id, name, level, sort_order)
       VALUES ($1,$2,$3,(SELECT COALESCE(max(sort_order), 0) + 1 FROM positions WHERE tenant_id=$1)) RETURNING *`,
      [tenantId, name, level],
    ) as Promise<PositionRow>;
  }

  /** Переименовать и/или сменить уровень. */
  update(tenantId: string, id: string, patch: { name?: string; level?: string }) {
    return this.db.one<PositionRow>(
      `UPDATE positions SET name=COALESCE($3, name), level=COALESCE($4, level) WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [tenantId, id, patch.name ?? null, patch.level ?? null],
    );
  }

  /** Порядок должностей целиком: как в списке — так и в выборе. Чужие id пропускаются. */
  async reorder(tenantId: string, ids: string[]): Promise<void> {
    await this.db.query(
      `UPDATE positions p SET sort_order = o.n
         FROM unnest($2::bigint[]) WITH ORDINALITY AS o(id, n)
        WHERE p.tenant_id=$1 AND p.id = o.id`,
      [tenantId, ids],
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
