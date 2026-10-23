import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DbService } from '../../database/db.service';

export interface GroupRow {
  id: string;
  tenant_id: string;
  name: string;
  kind: string;
  lead_user_id: string | null;
  /** #4615: направления отдела — задачи по ним уходят руководителю отдела. */
  directions: string[];
  /** #4615, 23.10: вышестоящий отдел — для вложенности. */
  parent_id: string | null;
  created_at: Date;
}

@Injectable()
export class GroupsRepository {
  constructor(private readonly db: DbService) {}

  list(tenantId: string) {
    return this.db.many(
      `SELECT g.*, (SELECT COUNT(*) FROM user_groups ug WHERE ug.group_id=g.id) AS member_count,
              COALESCE((SELECT array_agg(ug.user_id::text) FROM user_groups ug WHERE ug.group_id=g.id AND ug.role='deputy'), '{}') AS deputy_ids
         FROM groups g WHERE g.tenant_id=$1 ORDER BY g.name`,
      [tenantId],
    );
  }

  exists(tenantId: string, id: string): Promise<{ id: string } | null> {
    return this.db.one(`SELECT id FROM groups WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }

  create(tenantId: string, name: string, kind: string, leadUserId: string | null, parentId: string | null = null): Promise<GroupRow> {
    return this.db.one<GroupRow>(
      `INSERT INTO groups (tenant_id, name, kind, lead_user_id, parent_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [tenantId, name, kind, leadUserId, parentId],
    ) as Promise<GroupRow>;
  }

  /**
   * Можно ли сделать `parentId` вышестоящим для `id`: свой отдел той же компании и
   * без кольца (отдел не может входить сам в себя через цепочку).
   */
  async parentAllowed(tenantId: string, id: string | null, parentId: string): Promise<boolean> {
    if (id && String(id) === String(parentId)) return false;
    const rows = await this.db.many<{ id: string }>(
      `WITH RECURSIVE up AS (
         SELECT id, parent_id, 1 AS depth FROM groups WHERE tenant_id=$1 AND id=$2
         UNION ALL
         SELECT g.id, g.parent_id, up.depth + 1 FROM groups g JOIN up ON g.id = up.parent_id
          WHERE g.tenant_id=$1 AND up.depth < 50)
       SELECT id::text FROM up`, [tenantId, parentId],
    );
    if (!rows.length) return false;
    return !id || !rows.some((r) => String(r.id) === String(id));
  }

  update(tenantId: string, id: string, patch: { name?: string; kind?: string; leadUserId?: string | null; directions?: string[]; parentId?: string | null }) {
    const fields: string[] = [];
    const vals: any[] = [];
    let i = 1;
    if (patch.name !== undefined) { fields.push(`name=$${i++}`); vals.push(patch.name); }
    if (patch.kind !== undefined) { fields.push(`kind=$${i++}`); vals.push(patch.kind); }
    if (patch.leadUserId !== undefined) { fields.push(`lead_user_id=$${i++}`); vals.push(patch.leadUserId); }
    if (patch.directions !== undefined) { fields.push(`directions=$${i++}::text[]`); vals.push(patch.directions); }
    if (patch.parentId !== undefined) { fields.push(`parent_id=$${i++}`); vals.push(patch.parentId); }
    if (!fields.length) return this.db.one<GroupRow>(`SELECT * FROM groups WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
    vals.push(tenantId, id);
    return this.db.one<GroupRow>(
      `UPDATE groups SET ${fields.join(', ')} WHERE tenant_id=$${i++} AND id=$${i} RETURNING *`,
      vals,
    );
  }

  /** Руководитель — только из своей компании и действующий. */
  async userInTenant(tenantId: string, userId: string): Promise<boolean> {
    const row = await this.db.one<{ id: string }>(
      `SELECT id FROM users WHERE tenant_id=$1 AND id=$2 AND is_active = TRUE`, [tenantId, userId],
    ).catch(() => null);
    return !!row;
  }

  async remove(tenantId: string, id: string): Promise<void> {
    await this.db.query(`DELETE FROM groups WHERE tenant_id=$1 AND id=$2`, [tenantId, id]); // user_groups → ON DELETE CASCADE
  }

  /** Добавить в отдел; `role` — «deputy» (заместитель / тимлид) или обычный участник. */
  async addMember(tenantId: string, groupId: string, userId: string, role?: 'member' | 'deputy'): Promise<void> {
    await this.db.query(
      `INSERT INTO user_groups (tenant_id, user_id, group_id, role) VALUES ($1,$2,$3,COALESCE($4,'member'))
       ON CONFLICT (user_id, group_id) DO UPDATE SET role = COALESCE($4, user_groups.role)`,
      [tenantId, userId, groupId, role ?? null],
    );
  }

  async removeMember(groupId: string, userId: string): Promise<void> {
    await this.db.query(`DELETE FROM user_groups WHERE group_id=$1 AND user_id=$2`, [groupId, userId]);
  }

  listMembers(tenantId: string, groupId: string) {
    return this.db.many(
      `SELECT u.id, u.full_name, u.email, ug.role FROM user_groups ug
         JOIN users u ON u.id=ug.user_id
        WHERE ug.tenant_id=$1 AND ug.group_id=$2 ORDER BY u.full_name`,
      [tenantId, groupId],
    );
  }

  groupsForUser(tenantId: string, userId: string): Promise<Array<{ id: string; name: string; kind: string }>> {
    return this.db.many(
      `SELECT g.id, g.name, g.kind FROM user_groups ug JOIN groups g ON g.id=ug.group_id
        WHERE ug.tenant_id=$1 AND ug.user_id=$2 ORDER BY g.name`,
      [tenantId, userId],
    );
  }

  /**
   * Группы сразу всей команды, одним запросом.
   * Список сотрудников тянется на каждом открытии чатов и доски, и запрос
   * на человека в цикле превращался в десятки обращений к базе на ровном месте.
   */
  async groupsForUsers(tenantId: string): Promise<Map<string, Array<{ id: string; name: string; kind: string; role?: string }>>> {
    const rows = await this.db.many<{ user_id: string; id: string; name: string; kind: string; role: string }>(
      `SELECT ug.user_id, g.id, g.name, g.kind, ug.role FROM user_groups ug
         JOIN groups g ON g.id=ug.group_id
        WHERE ug.tenant_id=$1 ORDER BY g.name`,
      [tenantId],
    );
    const byUser = new Map<string, Array<{ id: string; name: string; kind: string; role?: string }>>();
    for (const r of rows) {
      const key = String(r.user_id);
      const list = byUser.get(key) ?? [];
      list.push({ id: r.id, name: r.name, kind: r.kind, role: r.role ?? 'member' });
      byUser.set(key, list);
    }
    return byUser;
  }

  /** Заменить набор групп пользователя (используется в PATCH /users/:id). */
  async setUserGroups(tenantId: string, userId: string, groupIds: string[]): Promise<void> {
    await this.db.withTransaction(async (client: PoolClient) => {
      // роль в отделе (тимлид) у оставшихся групп сохраняем: удаляем только снятые
      await client.query(
        `DELETE FROM user_groups WHERE tenant_id=$1 AND user_id=$2 AND NOT (group_id::text = ANY($3::text[]))`,
        [tenantId, userId, groupIds.map(String)],
      );
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
