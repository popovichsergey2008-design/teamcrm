import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface RateRow {
  id: string;
  tenant_id: string;
  user_id: string;
  hourly_rate: string;
  currency: string;
  effective_from: Date;
  effective_to: Date | null;
}

@Injectable()
export class RatesRepository {
  constructor(private readonly db: DbService) {}

  list(tenantId: string, userId: string): Promise<RateRow[]> {
    return this.db.many<RateRow>(
      `SELECT * FROM rates WHERE tenant_id=$1 AND user_id=$2 ORDER BY effective_from DESC`,
      [tenantId, userId],
    );
  }

  /**
   * Версионирование: закрывает текущую открытую ставку пользователя
   * (effective_to = effective_from новой) и вставляет новую — в одной транзакции.
   */
  async create(input: {
    tenantId: string;
    userId: string;
    hourlyRate: number;
    currency: string;
    effectiveFrom: Date;
  }): Promise<RateRow> {
    return this.db.withTransaction(async (client) => {
      // пользователь должен принадлежать tenant
      const u = await client.query(`SELECT 1 FROM users WHERE tenant_id=$1 AND id=$2`, [
        input.tenantId,
        input.userId,
      ]);
      if (!u.rowCount) throw new Error('USER_NOT_IN_TENANT');

      await client.query(
        `UPDATE rates SET effective_to=$3
          WHERE tenant_id=$1 AND user_id=$2 AND effective_to IS NULL AND effective_from < $3`,
        [input.tenantId, input.userId, input.effectiveFrom],
      );
      const res = await client.query<RateRow>(
        `INSERT INTO rates (tenant_id, user_id, hourly_rate, currency, effective_from)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [input.tenantId, input.userId, input.hourlyRate, input.currency, input.effectiveFrom],
      );
      return res.rows[0];
    });
  }
}
