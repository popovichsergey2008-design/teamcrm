import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DbService } from '../../database/db.service';

export interface GroupRow {
  id: string;
  tenant_id: string;
  name: string;
  kind: string;
  lead_user_id: string | null;
  created_at: Date;
}

@Injectable()
export class GroupsRepository {
  constructor(private readonly db: DbService) {}

  list(tenantId: string) {
    return this.db.many(
      `SELECT g.*, (SELECT COUNT(*) FROM user_groups ug WHERE ug.group_id=g.id) AS member_count
         FROM groups g WHERE g.tenant_id=$1 ORDER BY g.name`,
      [tenantId],
    );
  }

  exists(tenantId: string, id: string): Promise<{ id: string } | null> {
    return this.db.one(`SELECT id FROM groups WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }

  create(tenantId: string, name: string, kind: string, leadUserId: string | null): Promise<GroupRow> {
    return this.db.one<GroupRow>(
      `INSERT INTO groups (tenant_id, name, kind, lead_user_id) VALUES ($1,$2,$3,$4) RETURNING *`,
      [tenantId, name, kind, leadUserId],
    ) as Promise<GroupRow>;
  }

  update(tenantId: string, id: string, patch: { name?: string; kind?: string; leadUserId?: string | null }) {
    const fields: string[] = [];
    const vals: any[] = [];
    let i = 1;
    if (patch.name !== undefined) { fields.push(`name=$${i++}`); vals.push(patch.name); }
    if (patch.kind !== undefined) { fields.push(`kind=$${i++}`); vals.push(patch.kind); }
    if (patch.leadUserId !== undefined) { fields.push(`lead_user_id=$${i++}`); vals.push(patch.leadUserId); }
    if (!fields.length) return this.db.one<GroupRow>(`SELECT * FROM groups WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
    vals.push(tenantId, id);
    return this.db.one<GroupRow>(
      `UPDATE groups SET ${fields.join(', ')} WHERE tenant_id=$${i++} AND id=$${i} RETURNING *`,
      vals,
    );
  }

  async remove(tenantId: string, id: string): Promise<void> {
    await this.db.query(`DELETE FROM groups WHERE tenant_id=$1 AND id=$2`, [tenantId, id]); // user_groups → ON DELETE CASCADE
  }

  async addMember(tenantId: string, groupId: string, userId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO user_groups (tenant_id, user_id, group_id) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING`,
      [tenantId, userId, groupId],
    );
  }

  async removeMember(groupId: string, userId: string): Promise<void> {
    await this.db.query(`DELETE FROM user_groups WHERE group_id=$1 AND user_id=$2`, [groupId, userId]);
  }

  listMembers(tenantId: string, groupId: string) {
    return this.db.many(
      `SELECT u.id, u.full_name, u.email FROM user_groups ug
         JOIN users u ON u.id=ug.user_id
        WHERE ug.tenant_id=$1 AND ug.group_id=$2 ORDER BY u.full_name`,
      [tenantId, groupId],
    );
  }

  groupsForUser(tenantId: string, userId: string): Promise<Array<{ id: string; name: string }>> {
    return this.db.many(
      `SELECT g.id, g.name FROM user_groups ug JOIN groups g ON g.id=ug.group_id
        WHERE ug.tenant_id=$1 AND ug.user_id=$2 ORDER BY g.name`,
      [tenantId, userId],
    );
  }

  /** Заменить набор групп пользователя (используется в PATCH /users/:id). */
  async setUserGroups(tenantId: string, userId: string, groupIds: string[]): Promise<void> {
    await this.db.withTransaction(async (client: PoolClient) => {
      await client.query(`DELETE FROM user_groups WHERE tenant_id=$1 AND user_id=$2`, [tenantId, userId]);
      for (const gid of groupIds) {
        // только группы своего tenant
        await client.query(
          `INSERT INTO user_groups (tenant_id, user_id, group_id)
           SELECT $1,$2,$3 WHERE EXISTS (SELECT 1 FROM groups WHERE id=$3 AND tenant_id=$1)
           ON CONFLICT DO NOTHING`,
          [tenantId, userId, gid],
        );
      }
    });
  }
}
