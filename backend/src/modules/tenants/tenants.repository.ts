import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DbService } from '../../database/db.service';

export interface TenantRow {
  id: string;
  name: string;
  data_region: string;
  created_at: Date;
}

@Injectable()
export class TenantsRepository {
  constructor(private readonly db: DbService) {}

  async create(
    name: string,
    dataRegion: string,
    client?: PoolClient,
  ): Promise<TenantRow> {
    const text = `INSERT INTO tenants (name, data_region) VALUES ($1, $2) RETURNING *`;
    if (client) {
      const res = await client.query<TenantRow>(text, [name, dataRegion]);
      return res.rows[0];
    }
    return (await this.db.one<TenantRow>(text, [name, dataRegion])) as TenantRow;
  }
}
