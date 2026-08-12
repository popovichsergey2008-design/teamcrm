import { Injectable } from '@nestjs/common';
import { DbService } from '../../../database/db.service';

export interface ConnectionRow {
  id: string; tenant_id: string; provider: string; label: string | null; portal: string | null;
  webhook_enc: string; is_active: boolean; created_by: string | null; event_token: string;
}

/** Работа с общими таблицами интеграций для провайдера YouGile (origin='yougile'). */
@Injectable()
export class YougileRepository {
  constructor(private readonly db: DbService) {}

  // ── подключения ──
  createConnection(i: { tenantId: string; label: string | null; portal: string | null; webhookEnc: string; createdBy: string; eventToken: string }) {
    return this.db.one<ConnectionRow>(
      `INSERT INTO integration_connections (tenant_id, provider, label, portal, webhook_enc, created_by, event_token)
       VALUES ($1,'yougile',$2,$3,$4,$5,$6) RETURNING *`,
      [i.tenantId, i.label, i.portal, i.webhookEnc, i.createdBy, i.eventToken],
    ) as Promise<ConnectionRow>;
  }
  listConnections(tenantId: string) {
    return this.db.many(
      `SELECT id, label, portal, is_active, event_token, last_event_at, created_at FROM integration_connections
        WHERE tenant_id=$1 AND provider='yougile' ORDER BY created_at`,
      [tenantId],
    );
  }
  getConnection(tenantId: string, id: string): Promise<ConnectionRow | null> {
    return this.db.one<ConnectionRow>(`SELECT * FROM integration_connections WHERE tenant_id=$1 AND id=$2 AND provider='yougile'`, [tenantId, id]);
  }
  connectionByEventToken(token: string): Promise<ConnectionRow | null> {
    return this.db.one<ConnectionRow>(`SELECT * FROM integration_connections WHERE event_token=$1 AND provider='yougile' AND is_active=TRUE`, [token]);
  }
  async deleteConnection(tenantId: string, id: string): Promise<void> {
    await this.db.query(`UPDATE projects SET origin_connection_id=NULL WHERE tenant_id=$1 AND origin_connection_id=$2`, [tenantId, id]);
    await this.db.query(`DELETE FROM external_refs WHERE tenant_id=$1 AND connection_id=$2`, [tenantId, id]);
    await this.db.query(`DELETE FROM import_runs WHERE tenant_id=$1 AND connection_id=$2`, [tenantId, id]);
    await this.db.query(`DELETE FROM integration_connections WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }

  // ── external_refs ──
  getRef(connectionId: string, entityType: string, externalId: string) {
    return this.db.one<{ local_id: string; external_hash: string | null }>(
      `SELECT local_id, external_hash FROM external_refs WHERE connection_id=$1 AND entity_type=$2 AND external_id=$3`,
      [connectionId, entityType, String(externalId)],
    );
  }
  async putRef(i: { tenantId: string; connectionId: string; entityType: string; externalId: string; localId: string; hash?: string | null }) {
    await this.db.query(
      `INSERT INTO external_refs (tenant_id, connection_id, entity_type, external_id, local_id, external_hash)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (connection_id, entity_type, external_id)
       DO UPDATE SET local_id=EXCLUDED.local_id, external_hash=EXCLUDED.external_hash, synced_at=now()`,
      [i.tenantId, i.connectionId, i.entityType, String(i.externalId), i.localId, i.hash ?? null],
    );
  }
  async userRefs(connectionId: string): Promise<Map<string, string>> {
    const rows = await this.db.many<{ external_id: string; local_id: string }>(
      `SELECT external_id, local_id FROM external_refs WHERE connection_id=$1 AND entity_type='user'`, [connectionId]);
    const m = new Map<string, string>();
    for (const r of rows) m.set(String(r.external_id), r.local_id);
    return m;
  }
  async userEmailMap(tenantId: string): Promise<Map<string, string>> {
    const rows = await this.db.many<{ id: string; email: string }>(
      `SELECT id, email FROM users WHERE tenant_id=$1 AND email IS NOT NULL`, [tenantId]);
    const m = new Map<string, string>();
    for (const r of rows) m.set(r.email.toLowerCase(), r.id);
    return m;
  }

  // ── import_runs ──
  createRun(tenantId: string, connectionId: string, scope: unknown) {
    return this.db.one<{ id: string }>(
      `INSERT INTO import_runs (tenant_id, connection_id, status, scope) VALUES ($1,$2,'queued',$3) RETURNING id`,
      [tenantId, connectionId, JSON.stringify(scope)],
    );
  }
  getRun(tenantId: string, id: string) {
    return this.db.one(`SELECT * FROM import_runs WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }
  async setRunRunning(id: string) { await this.db.query(`UPDATE import_runs SET status='running', started_at=now() WHERE id=$1`, [id]); }
  async setRunStats(id: string, stats: unknown) { await this.db.query(`UPDATE import_runs SET stats=$2 WHERE id=$1`, [id, JSON.stringify(stats)]); }
  async finishRun(id: string, status: 'done' | 'error', stats: unknown, error?: string) {
    await this.db.query(`UPDATE import_runs SET status=$2, stats=$3, error=$4, finished_at=now() WHERE id=$1`,
      [id, status, JSON.stringify(stats ?? {}), error ?? null]);
  }

  // ── upsert проект (доска YouGile → проект, origin='yougile') ──
  async upsertProject(i: { tenantId: string; connectionId: string; externalId: string; name: string }): Promise<{ id: string; created: boolean }> {
    const ref = await this.getRef(i.connectionId, 'project', i.externalId);
    if (ref) {
      await this.db.query(`UPDATE projects SET name=$3, updated_at=now() WHERE tenant_id=$1 AND id=$2`, [i.tenantId, ref.local_id, i.name]);
      return { id: ref.local_id, created: false };
    }
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO projects (tenant_id, name, origin, origin_connection_id) VALUES ($1,$2,'yougile',$3) RETURNING id`,
      [i.tenantId, i.name, i.connectionId]);
    await this.putRef({ tenantId: i.tenantId, connectionId: i.connectionId, entityType: 'project', externalId: i.externalId, localId: row!.id });
    return { id: row!.id, created: true };
  }

  async upsertColumn(i: { tenantId: string; connectionId: string; projectId: string; externalId: string; name: string; position: number }): Promise<string> {
    const ref = await this.getRef(i.connectionId, 'column', i.externalId);
    if (ref) {
      await this.db.query(`UPDATE board_columns SET name=$3, position=$4 WHERE tenant_id=$1 AND id=$2`, [i.tenantId, ref.local_id, i.name, i.position]);
      return ref.local_id;
    }
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO board_columns (tenant_id, project_id, name, position) VALUES ($1,$2,$3,$4) RETURNING id`,
      [i.tenantId, i.projectId, i.name, i.position]);
    await this.putRef({ tenantId: i.tenantId, connectionId: i.connectionId, entityType: 'column', externalId: i.externalId, localId: row!.id });
    return row!.id;
  }

  /** Гарантирует хотя бы одну колонку (если у доски их нет). */
  async ensureFallbackColumn(tenantId: string, projectId: string): Promise<string> {
    const existing = await this.db.one<{ id: string }>(`SELECT id FROM board_columns WHERE tenant_id=$1 AND project_id=$2 ORDER BY position LIMIT 1`, [tenantId, projectId]);
    if (existing) return existing.id;
    const row = await this.db.one<{ id: string }>(`INSERT INTO board_columns (tenant_id, project_id, name, position) VALUES ($1,$2,'Задачи',0) RETURNING id`, [tenantId, projectId]);
    return row!.id;
  }

  userExists(tenantId: string, userId: string) {
    return this.db.one(`SELECT id FROM users WHERE tenant_id=$1 AND id=$2`, [tenantId, userId]);
  }

  // ── комментарий задачи (идемпотентно по external_refs 'comment') ──
  async upsertComment(i: { tenantId: string; connectionId: string; externalId: string; taskId: string; authorId: string; body: string; postedAt: string | null }): Promise<boolean> {
    if (await this.getRef(i.connectionId, 'comment', i.externalId)) return false;
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO task_comments (tenant_id, task_id, author_id, body, created_at) VALUES ($1,$2,$3,$4, COALESCE($5, now())) RETURNING id`,
      [i.tenantId, i.taskId, i.authorId, i.body, i.postedAt]);
    await this.putRef({ tenantId: i.tenantId, connectionId: i.connectionId, entityType: 'comment', externalId: i.externalId, localId: row!.id });
    return true;
  }

  // ── вложение задачи (идемпотентно по external file id) ──
  attachmentExists(connectionId: string, externalFileId: string) {
    return this.getRef(connectionId, 'file', externalFileId);
  }
  async addAttachment(i: { tenantId: string; connectionId: string; externalFileId: string; taskId: string; fileId: string }) {
    await this.db.query(
      `INSERT INTO task_attachments (tenant_id, task_id, file_id) VALUES ($1,$2,$3) ON CONFLICT (task_id, file_id) DO NOTHING`,
      [i.tenantId, i.taskId, i.fileId]);
    await this.putRef({ tenantId: i.tenantId, connectionId: i.connectionId, entityType: 'file', externalId: i.externalFileId, localId: i.fileId });
  }

  private async nextPosition(tenantId: string, columnId: string): Promise<number> {
    const r = await this.db.one<{ next: number }>(`SELECT COALESCE(MAX(position)+1,0) AS next FROM tasks WHERE tenant_id=$1 AND column_id=$2`, [tenantId, columnId]);
    return r?.next ?? 0;
  }

  // ── upsert задачи (идемпотентно по hash) ──
  async upsertTask(i: {
    tenantId: string; connectionId: string; externalId: string; projectId: string; columnId: string;
    title: string; description: string | null; assigneeId: string | null; createdBy: string | null;
    priority: string; deadlineAt: string | null; status: string; closed: boolean; hash: string;
  }): Promise<{ id: string; changed: boolean }> {
    const ref = await this.getRef(i.connectionId, 'task', i.externalId);
    if (ref) {
      if (ref.external_hash === i.hash) return { id: ref.local_id, changed: false };
      const cur = await this.db.one<{ column_id: string }>(`SELECT column_id FROM tasks WHERE tenant_id=$1 AND id=$2`, [i.tenantId, ref.local_id]);
      const moved = cur && String(cur.column_id) !== String(i.columnId);
      const position = moved ? await this.nextPosition(i.tenantId, i.columnId) : undefined;
      await this.db.query(
        `UPDATE tasks SET title=$3, description=$4, column_id=$5, assignee_id=$6, created_by=$7,
             priority=$8, deadline_at=$9, status=$10, closed_at=$11, position=COALESCE($12, position), project_id=$13, updated_at=now()
          WHERE tenant_id=$1 AND id=$2`,
        [i.tenantId, ref.local_id, i.title, i.description, i.columnId, i.assigneeId, i.createdBy,
          i.priority, i.deadlineAt, i.status, i.closed ? new Date().toISOString() : null, position ?? null, i.projectId]);
      await this.putRef({ tenantId: i.tenantId, connectionId: i.connectionId, entityType: 'task', externalId: i.externalId, localId: ref.local_id, hash: i.hash });
      return { id: ref.local_id, changed: true };
    }
    const position = await this.nextPosition(i.tenantId, i.columnId);
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO tasks (tenant_id, project_id, column_id, position, title, description, assignee_id, created_by, status, priority, deadline_at, closed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [i.tenantId, i.projectId, i.columnId, position, i.title, i.description, i.assigneeId, i.createdBy, i.status, i.priority, i.deadlineAt, i.closed ? new Date().toISOString() : null]);
    await this.putRef({ tenantId: i.tenantId, connectionId: i.connectionId, entityType: 'task', externalId: i.externalId, localId: row!.id, hash: i.hash });
    return { id: row!.id, changed: true };
  }
}
