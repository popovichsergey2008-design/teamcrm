import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface InboxSourceRow {
  id: string; tenant_id: string; label: string | null; token: string;
  default_project_id: string | null; created_by: string | null; is_active: boolean;
}

@Injectable()
export class InboxRepository {
  constructor(private readonly db: DbService) {}

  createSource(i: { tenantId: string; label: string | null; token: string; defaultProjectId: string | null; createdBy: string }) {
    return this.db.one<InboxSourceRow>(
      `INSERT INTO inbox_sources (tenant_id, label, token, default_project_id, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [i.tenantId, i.label, i.token, i.defaultProjectId, i.createdBy],
    );
  }
  listSources(tenantId: string) {
    return this.db.many(
      `SELECT s.id, s.label, s.token, s.default_project_id, s.is_active, s.created_at, p.name AS default_project_name,
              (SELECT count(*)::int FROM inbox_items i WHERE i.source_id=s.id AND i.status='pending') AS pending
         FROM inbox_sources s LEFT JOIN projects p ON p.id=s.default_project_id
        WHERE s.tenant_id=$1 ORDER BY s.created_at DESC`,
      [tenantId],
    );
  }
  sourceByToken(token: string) {
    return this.db.one<InboxSourceRow>(`SELECT * FROM inbox_sources WHERE token=$1 AND is_active=TRUE`, [token]);
  }
  async deleteSource(tenantId: string, id: string) {
    await this.db.query(`DELETE FROM inbox_sources WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }

  createItem(i: { tenantId: string; sourceId: string; sender: string | null; subject: string | null; body: string }) {
    return this.db.one<{ id: string }>(
      `INSERT INTO inbox_items (tenant_id, source_id, sender, subject, body) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [i.tenantId, i.sourceId, i.sender, i.subject, i.body],
    );
  }
  async setItemResult(id: string, status: string, draft: unknown | null) {
    // не затираем уже принятое человеком решение: фоновый парсинг может завершиться
    // ПОСЛЕ того, как черновик подтвердили/отклонили (created|dismissed) — такие не трогаем.
    await this.db.query(
      `UPDATE inbox_items SET status=$2, draft=$3, processed_at=now()
        WHERE id=$1 AND status NOT IN ('created','dismissed')`,
      [id, status, draft === null ? null : JSON.stringify(draft)],
    );
  }
  getItem(tenantId: string, id: string) {
    return this.db.one<any>(`SELECT * FROM inbox_items WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }
  listItems(tenantId: string, status: string) {
    return this.db.many(
      `SELECT i.id, i.sender, i.subject, i.body, i.status, i.draft, i.task_id, i.created_at, s.label AS source_label
         FROM inbox_items i JOIN inbox_sources s ON s.id=i.source_id
        WHERE i.tenant_id=$1 AND i.status=$2 ORDER BY i.created_at DESC LIMIT 200`,
      [tenantId, status],
    );
  }
  async markCreated(tenantId: string, id: string, taskId: string) {
    await this.db.query(`UPDATE inbox_items SET status='created', task_id=$3, processed_at=now() WHERE tenant_id=$1 AND id=$2`, [tenantId, id, taskId]);
  }
  async markDismissed(tenantId: string, id: string) {
    await this.db.query(`UPDATE inbox_items SET status='dismissed', processed_at=now() WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }
}
