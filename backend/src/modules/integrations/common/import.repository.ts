import { Injectable } from '@nestjs/common';
import { DbService } from '../../../database/db.service';

export interface ConnectionRow {
  id: string; tenant_id: string; provider: string; label: string | null; portal: string | null;
  webhook_enc: string; is_active: boolean; created_by: string | null;
}

/**
 * Хранилище импорта — общее для всех источников «переезда в один клик».
 *
 * Работает на ОБЩИХ таблицах интеграций (`integration_connections`, `external_refs`,
 * `import_runs`) — тех же, на которых живут Битрикс и YouGile. Источник различается
 * ТОЛЬКО значением `provider`: заводить третью пару таблиц под Trello и четвёртую под
 * Notion значит превратить историю прогонов в три разные истории.
 *
 * Секрет источника (ключ, пара «ключ:токен», токен интеграции) лежит в `webhook_enc`
 * в зашифрованном виде.
 */
@Injectable()
export class ImportRepository {
  constructor(private readonly db: DbService) {}

  // ── подключения ──
  createConnection(i: {
    provider: string; tenantId: string; label: string | null;
    portal: string | null; secretEnc: string; createdBy: string;
  }) {
    return this.db.one<ConnectionRow>(
      `INSERT INTO integration_connections (tenant_id, provider, label, portal, webhook_enc, created_by, event_token)
       VALUES ($1,$2,$3,$4,$5,$6, md5(random()::text || clock_timestamp()::text)) RETURNING *`,
      [i.tenantId, i.provider, i.label, i.portal, i.secretEnc, i.createdBy],
    ) as Promise<ConnectionRow>;
  }

  listConnections(tenantId: string, provider: string) {
    return this.db.many(
      `SELECT id, label, portal, is_active, created_at FROM integration_connections
        WHERE tenant_id=$1 AND provider=$2 ORDER BY created_at`,
      [tenantId, provider],
    );
  }

  getConnection(tenantId: string, id: string, provider: string): Promise<ConnectionRow | null> {
    return this.db.one<ConnectionRow>(
      `SELECT * FROM integration_connections WHERE tenant_id=$1 AND id=$2 AND provider=$3`,
      [tenantId, id, provider],
    );
  }

  /** Отключение НЕ трогает импортированные задачи: это сделанная работа, а не мусор. */
  async deleteConnection(tenantId: string, id: string): Promise<void> {
    await this.db.query(`UPDATE projects SET origin_connection_id=NULL WHERE tenant_id=$1 AND origin_connection_id=$2`, [tenantId, id]);
    await this.db.query(`DELETE FROM external_refs WHERE tenant_id=$1 AND connection_id=$2`, [tenantId, id]);
    await this.db.query(`DELETE FROM import_runs WHERE tenant_id=$1 AND connection_id=$2`, [tenantId, id]);
    await this.db.query(`DELETE FROM integration_connections WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }

  // ── соответствия внешних объектов ──
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
      `SELECT external_id, local_id FROM external_refs WHERE connection_id=$1 AND entity_type='user'`,
      [connectionId],
    );
    return new Map(rows.map((r) => [String(r.external_id), String(r.local_id)]));
  }

  /**
   * Сбросить хеши задач подключения.
   *
   * Нужно после ручной привязки человека: хеш считается по данным СО СТОРОНЫ Trello,
   * а привязка живёт у нас. Без сброса повторный импорт решит, что карточки не
   * менялись, и новый исполнитель доедет только до новых задач — ровно на эти грабли
   * мы уже наступали в YouGile.
   */
  async resetTaskHashes(connectionId: string): Promise<number> {
    const res = await this.db.query(
      `UPDATE external_refs SET external_hash=NULL
        WHERE connection_id=$1 AND entity_type='task' AND external_hash IS NOT NULL`,
      [connectionId],
    );
    return res.rowCount ?? 0;
  }

  userExists(tenantId: string, userId: string) {
    return this.db.one(`SELECT id FROM users WHERE tenant_id=$1 AND id=$2`, [tenantId, userId]);
  }

  /** Почты сотрудников: первый и самый надёжный способ узнать человека. */
  async userEmailMap(tenantId: string): Promise<Map<string, string>> {
    const rows = await this.db.many<{ id: string; email: string }>(
      `SELECT id, email FROM users WHERE tenant_id=$1 AND email IS NOT NULL`, [tenantId]);
    return new Map(rows.map((r) => [r.email.toLowerCase(), String(r.id)]));
  }

  /** Имена сотрудников: запасной способ, когда почты в Trello нет (а её почти всегда нет). */
  async userNameMap(tenantId: string): Promise<Map<string, string>> {
    const rows = await this.db.many<{ id: string; full_name: string }>(
      `SELECT id, full_name FROM users WHERE tenant_id=$1 AND full_name IS NOT NULL`, [tenantId]);
    const m = new Map<string, string>();
    for (const r of rows) {
      const key = String(r.full_name).toLowerCase().split(/\s+/).filter(Boolean).sort().join(' ');
      if (key) m.set(key, String(r.id));
    }
    return m;
  }

  // ── журнал прогонов ──
  createRun(tenantId: string, connectionId: string, scope: unknown) {
    return this.db.one<{ id: string }>(
      `INSERT INTO import_runs (tenant_id, connection_id, status, scope) VALUES ($1,$2,'queued',$3) RETURNING id`,
      [tenantId, connectionId, JSON.stringify(scope)],
    );
  }
  getRun(tenantId: string, id: string) {
    return this.db.one(`SELECT * FROM import_runs WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }
  async setRunRunning(id: string) {
    await this.db.query(`UPDATE import_runs SET status='running', started_at=now() WHERE id=$1`, [id]);
  }
  async setRunStats(id: string, stats: unknown) {
    await this.db.query(`UPDATE import_runs SET stats=$2 WHERE id=$1`, [id, JSON.stringify(stats)]);
  }
  async finishRun(id: string, status: 'done' | 'error', stats: unknown, error?: string) {
    await this.db.query(
      `UPDATE import_runs SET status=$2, stats=$3, error=$4, finished_at=now() WHERE id=$1`,
      [id, status, JSON.stringify(stats ?? {}), error ?? null],
    );
  }

  // ── доска → проект, список → колонка, карточка → задача ──
  async upsertProject(i: {
    tenantId: string; connectionId: string; externalId: string; name: string;
    /** Происхождение проекта: 'trello' | 'notion' — по нему видно, откуда доска. */
    origin: string;
  }): Promise<{ id: string; created: boolean }> {
    const ref = await this.getRef(i.connectionId, 'project', i.externalId);
    if (ref) {
      await this.db.query(`UPDATE projects SET name=$3, updated_at=now() WHERE tenant_id=$1 AND id=$2`, [i.tenantId, ref.local_id, i.name]);
      return { id: ref.local_id, created: false };
    }
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO projects (tenant_id, name, origin, origin_connection_id) VALUES ($1,$2,$4,$3) RETURNING id`,
      [i.tenantId, i.name, i.connectionId, i.origin],
    );
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
      [i.tenantId, i.projectId, i.name, i.position],
    );
    await this.putRef({ tenantId: i.tenantId, connectionId: i.connectionId, entityType: 'column', externalId: i.externalId, localId: row!.id });
    return row!.id;
  }

  /** У доски без списков всё равно должна быть колонка, иначе задачи некуда класть. */
  async ensureFallbackColumn(tenantId: string, projectId: string): Promise<string> {
    const existing = await this.db.one<{ id: string }>(
      `SELECT id FROM board_columns WHERE tenant_id=$1 AND project_id=$2 ORDER BY position LIMIT 1`, [tenantId, projectId]);
    if (existing) return existing.id;
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO board_columns (tenant_id, project_id, name, position) VALUES ($1,$2,'Задачи',0) RETURNING id`, [tenantId, projectId]);
    return row!.id;
  }

  private async nextPosition(tenantId: string, columnId: string): Promise<number> {
    const row = await this.db.one<{ next: number }>(
      `SELECT COALESCE(MAX(position) + 1, 0) AS next FROM tasks WHERE tenant_id=$1 AND column_id=$2`, [tenantId, columnId]);
    return Number(row?.next ?? 0);
  }

  async upsertTask(i: {
    tenantId: string; connectionId: string; externalId: string; projectId: string; columnId: string;
    title: string; description: string | null; assigneeId: string | null; createdBy: string | null;
    priority: string; deadlineAt: string | null; status: string; closed: boolean; hash: string;
  }): Promise<{ id: string; created: boolean; changed: boolean }> {
    const ref = await this.getRef(i.connectionId, 'task', i.externalId);
    if (ref) {
      if (ref.external_hash === i.hash) return { id: ref.local_id, created: false, changed: false };
      const cur = await this.db.one<{ column_id: string }>(`SELECT column_id FROM tasks WHERE tenant_id=$1 AND id=$2`, [i.tenantId, ref.local_id]);
      const moved = cur && String(cur.column_id) !== String(i.columnId);
      const position = moved ? await this.nextPosition(i.tenantId, i.columnId) : null;
      await this.db.query(
        `UPDATE tasks SET title=$3, description=$4, column_id=$5, assignee_id=$6,
             priority=$7, deadline_at=$8, status=$9,
             closed_at = CASE WHEN $10 THEN COALESCE(closed_at, now()) ELSE NULL END,
             position=COALESCE($11, position), updated_at=now()
          WHERE tenant_id=$1 AND id=$2`,
        [i.tenantId, ref.local_id, i.title, i.description, i.columnId, i.assigneeId,
          i.priority, i.deadlineAt, i.status, i.closed, position],
      );
      await this.putRef({ tenantId: i.tenantId, connectionId: i.connectionId, entityType: 'task', externalId: i.externalId, localId: ref.local_id, hash: i.hash });
      return { id: ref.local_id, created: false, changed: true };
    }
    const position = await this.nextPosition(i.tenantId, i.columnId);
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO tasks (tenant_id, project_id, column_id, position, title, description, assignee_id, created_by,
                          status, priority, deadline_at, closed_at, requires_approval)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, FALSE) RETURNING id`,
      [i.tenantId, i.projectId, i.columnId, position, i.title, i.description, i.assigneeId, i.createdBy,
        i.status, i.priority, i.deadlineAt, i.closed ? new Date().toISOString() : null],
    );
    await this.putRef({ tenantId: i.tenantId, connectionId: i.connectionId, entityType: 'task', externalId: i.externalId, localId: row!.id, hash: i.hash });
    return { id: row!.id, created: true, changed: true };
  }

  /** Комментарий карточки. Идемпотентно: второй прогон не удваивает переписку. */
  async upsertComment(i: {
    tenantId: string; connectionId: string; externalId: string; taskId: string;
    authorId: string; body: string; postedAt: string | null;
  }): Promise<boolean> {
    if (await this.getRef(i.connectionId, 'comment', i.externalId)) return false;
    // Вторая опора идемпотентности — содержимое: см. yougile.repository.upsertComment.
    const same = await this.db.one<{ id: string }>(
      `SELECT id FROM task_comments
        WHERE tenant_id=$1 AND task_id=$2 AND author_id=$3 AND body=$4
        ORDER BY created_at LIMIT 1`,
      [i.tenantId, i.taskId, i.authorId, i.body],
    );
    if (same) {
      await this.putRef({ tenantId: i.tenantId, connectionId: i.connectionId, entityType: 'comment', externalId: i.externalId, localId: same.id });
      return false;
    }
    const row = await this.db.one<{ id: string }>(
      `WITH src AS (
         SELECT COALESCE(
                  $5::timestamptz,
                  (SELECT max(c.created_at) FROM task_comments c WHERE c.tenant_id=$1 AND c.task_id=$2),
                  (SELECT t.created_at FROM tasks t WHERE t.id=$2),
                  now()
                ) AS at
       )
       INSERT INTO task_comments (tenant_id, task_id, author_id, body, created_at)
       SELECT $1, $2, $3, $4, src.at FROM src RETURNING id`,
      [i.tenantId, i.taskId, i.authorId, i.body, i.postedAt],
    );
    await this.putRef({ tenantId: i.tenantId, connectionId: i.connectionId, entityType: 'comment', externalId: i.externalId, localId: row!.id });
    return true;
  }

  /** Чек-лист карточки: переписываем целиком — так проще, чем сводить два списка. */
  async replaceChecklist(tenantId: string, taskId: string, items: { text: string; done: boolean }[]): Promise<void> {
    await this.db.withTransaction(async (c) => {
      await c.query(`DELETE FROM task_checklist_items WHERE tenant_id=$1 AND task_id=$2`, [tenantId, taskId]);
      for (let i = 0; i < items.length; i++) {
        await c.query(
          `INSERT INTO task_checklist_items (tenant_id, task_id, text, is_done, position) VALUES ($1,$2,$3,$4,$5)`,
          [tenantId, taskId, items[i].text.slice(0, 500), items[i].done, i],
        );
      }
    });
  }

  /** Метка по имени: одноимённые метки разных досок переиспользуют одну запись. */
  async ensureLabel(tenantId: string, name: string, color: string): Promise<string> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO labels (tenant_id, name, color) VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id, name) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
      [tenantId, name.slice(0, 48), color],
    );
    return row!.id;
  }

  async setTaskLabels(tenantId: string, taskId: string, labelIds: string[]): Promise<void> {
    await this.db.withTransaction(async (c) => {
      await c.query(`DELETE FROM task_labels WHERE tenant_id=$1 AND task_id=$2`, [tenantId, taskId]);
      for (const id of labelIds) {
        await c.query(`INSERT INTO task_labels (tenant_id, task_id, label_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [tenantId, taskId, id]);
      }
    });
  }

  async addAttachment(i: { tenantId: string; connectionId: string; externalFileId: string; taskId: string; fileId: string }): Promise<void> {
    await this.db.query(
      `INSERT INTO task_attachments (tenant_id, task_id, file_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [i.tenantId, i.taskId, i.fileId],
    );
    await this.putRef({
      tenantId: i.tenantId, connectionId: i.connectionId, entityType: 'file',
      externalId: i.externalFileId, localId: i.fileId,
    });
  }
}
