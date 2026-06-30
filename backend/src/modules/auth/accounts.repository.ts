import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DbService } from '../../database/db.service';

export interface AccountRow {
  id: string;
  email: string;
  password_hash: string;
  full_name: string;
}

@Injectable()
export class AccountsRepository {
  constructor(private readonly db: DbService) {}

  findByEmail(email: string): Promise<AccountRow | null> {
    return this.db.one<AccountRow>(`SELECT * FROM accounts WHERE lower(email)=lower($1)`, [email]);
  }

  findById(id: string): Promise<AccountRow | null> {
    return this.db.one<AccountRow>(`SELECT * FROM accounts WHERE id=$1`, [id]);
  }

  async create(
    email: string,
    passwordHash: string,
    fullName: string,
    client?: PoolClient,
  ): Promise<AccountRow> {
    const text = `INSERT INTO accounts (email, password_hash, full_name) VALUES ($1,$2,$3) RETURNING *`;
    if (client) return (await client.query<AccountRow>(text, [email, passwordHash, fullName])).rows[0];
    return (await this.db.one<AccountRow>(text, [email, passwordHash, fullName])) as AccountRow;
  }

  async updatePassword(id: string, hash: string): Promise<void> {
    await this.db.query(`UPDATE accounts SET password_hash=$2, updated_at=now() WHERE id=$1`, [id, hash]);
  }
}
