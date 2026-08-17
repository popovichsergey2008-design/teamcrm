import { Injectable } from '@nestjs/common';
import { DbService } from '../../../database/db.service';
import { DONE_COLUMN_NAMES } from '../../tasks/task-columns';

export interface ConnectionRow {
  id: string; tenant_id: string; provider: string; label: string | null; portal: string | null;
  webhook_enc: string; is_active: boolean; created_by: string | null; event_token: string;
  push_enabled: boolean;
}

/** Строка очереди выгрузки CRM → YouGile (integration_outbox). */
export interface OutboxRow {
  id: string; tenant_id: string; connection_id: string; kind: string;
  local_id: string; payload: Record<string, any> | null; attempts: number;
}

/** Поля задачи, которые CRM выгружает в YouGile. */
export interface PushTaskRow {
  id: string; project_id: string; column_id: string; title: string;
  description: string | null; assignee_id: string | null; priority: string;
  deadline_at: Date | null; closed_at: Date | null;
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
      `SELECT id, label, portal, is_active, event_token, last_event_at, push_enabled, created_at FROM integration_connections
        WHERE tenant_id=$1 AND provider='yougile' ORDER BY created_at`,
      [tenantId],
    );
  }
  /** Включение/выключение выгрузки CRM → YouGile на подключении (E4). */
  async setPush(tenantId: string, id: string, enabled: boolean): Promise<void> {
    await this.db.query(
      `UPDATE integration_connections SET push_enabled=$3, updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND provider='yougile'`,
      [tenantId, id, enabled],
    );
  }
  getConnection(tenantId: string, id: string): Promise<ConnectionRow | null> {
    return this.db.one<ConnectionRow>(`SELECT * FROM integration_connections WHERE tenant_id=$1 AND id=$2 AND provider='yougile'`, [tenantId, id]);
  }
  connectionByEventToken(token: string): Promise<ConnectionRow | null> {
    return this.db.one<ConnectionRow>(`SELECT * FROM integration_connections WHERE event_token=$1 AND provider='yougile' AND is_active=TRUE`, [token]);
  }
  async touchEvent(id: string) {
    await this.db.query(`UPDATE integration_connections SET last_event_at=now() WHERE id=$1`, [id]);
  }
  /** Локальная колонка по внешнему id + её проект (для инкрементальной синхронизации). */
  async columnTarget(connectionId: string, externalColumnId: string): Promise<{ columnId: string; projectId: string } | null> {
    const ref = await this.getRef(connectionId, 'column', externalColumnId);
    if (!ref) return null;
    const row = await this.db.one<{ project_id: string }>(`SELECT project_id FROM board_columns WHERE id=$1`, [ref.local_id]);
    if (!row) return null;
    return { columnId: ref.local_id, projectId: row.project_id };
  }
  /** Удаляет импортированную задачу и её комментарии/вложения/refs (событие task-deleted). */
  async deleteImportedTask(tenantId: string, connectionId: string, externalTaskId: string): Promise<boolean> {
    const ref = await this.getRef(connectionId, 'task', externalTaskId);
    if (!ref) return false;
    const localId = ref.local_id;
    await this.db.withTransaction(async (c) => {
      const t: [string, string] = [tenantId, localId];
      await c.query(`DELETE FROM external_refs WHERE connection_id=$1 AND entity_type='comment' AND local_id IN (SELECT id FROM task_comments WHERE tenant_id=$2 AND task_id=$3)`, [connectionId, tenantId, localId]);
      await c.query(`DELETE FROM external_refs WHERE connection_id=$1 AND entity_type='file' AND local_id IN (SELECT file_id FROM task_attachments WHERE tenant_id=$2 AND task_id=$3)`, [connectionId, tenantId, localId]);
      await c.query(`DELETE FROM external_refs WHERE connection_id=$1 AND entity_type='chat_echo' AND local_id=$2`, [connectionId, localId]);
      for (const tbl of ['task_comments', 'task_attachments', 'task_labels', 'task_watchers', 'task_checklist_items', 'task_activity', 'time_logs']) {
        await c.query(`DELETE FROM ${tbl} WHERE tenant_id=$1 AND task_id=$2`, t);
      }
      await c.query(`DELETE FROM external_refs WHERE connection_id=$1 AND entity_type='task' AND external_id=$2`, [connectionId, externalTaskId]);
      await c.query(`DELETE FROM tasks WHERE tenant_id=$1 AND id=$2`, t);
    });
    return true;
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
  /** Обратный поиск: локальный объект → внешний id (нужен для выгрузки CRM → YouGile). */
  refByLocal(connectionId: string, entityType: string, localId: string) {
    return this.db.one<{ external_id: string; external_hash: string | null }>(
      `SELECT external_id, external_hash FROM external_refs
        WHERE connection_id=$1 AND entity_type=$2 AND local_id=$3`,
      [connectionId, entityType, localId],
    );
  }
  /**
   * Сбрасывает хеши задач подключения. Нужен после ручной привязки пользователя:
   * хеш считается по данным СО СТОРОНЫ YouGile, а привязка живёт у нас — без сброса
   * импорт решит, что задача не изменилась, и новый исполнитель/руководитель не применится.
   */
  async resetTaskHashes(connectionId: string): Promise<number> {
    const res = await this.db.query(
      `UPDATE external_refs SET external_hash=NULL
        WHERE connection_id=$1 AND entity_type='task' AND external_hash IS NOT NULL`,
      [connectionId],
    );
    return res.rowCount ?? 0;
  }

  async deleteRef(connectionId: string, entityType: string, externalId: string): Promise<void> {
    await this.db.query(`DELETE FROM external_refs WHERE connection_id=$1 AND entity_type=$2 AND external_id=$3`,
      [connectionId, entityType, String(externalId)]);
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

  /**
   * Колонка «Готово» проекта, если она есть.
   * В YouGile «завершено» — флажок на задаче, не зависящий от колонки, поэтому
   * закрытая задача приезжает в свою «Паузу» и висит там с отметкой «завершена».
   */
  async doneColumnId(tenantId: string, projectId: string): Promise<string | null> {
    const row = await this.db.one<{ id: string }>(
      `SELECT id FROM board_columns
        WHERE tenant_id=$1 AND project_id=$2 AND lower(btrim(name)) = ANY($3::text[])
        ORDER BY position LIMIT 1`,
      [tenantId, projectId, DONE_COLUMN_NAMES],
    );
    return row?.id ?? null;
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

  // ── метки из стикеров YouGile ──

  /**
   * Метка под состояние стикера: заводим один раз и запоминаем в external_refs.
   * Имя метки уникально в организации, поэтому одноимённые состояния разных стикеров
   * (и уже заведённая вручную метка с тем же именем) переиспользуют одну запись.
   */
  async ensureLabel(i: { tenantId: string; connectionId: string; externalId: string; name: string; color: string }): Promise<string> {
    const ref = await this.getRef(i.connectionId, 'label', i.externalId);
    if (ref) return ref.local_id;
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO labels (tenant_id, name, color) VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id, name) DO UPDATE SET name=labels.name
       RETURNING id`,
      [i.tenantId, i.name, i.color],
    );
    await this.putRef({ tenantId: i.tenantId, connectionId: i.connectionId, entityType: 'label', externalId: i.externalId, localId: row!.id });
    return row!.id;
  }

  /** Метки, заведённые интеграцией: только их импорт вправе снимать с задачи. */
  async importedLabelIds(connectionId: string): Promise<Set<string>> {
    const rows = await this.db.many<{ local_id: string }>(
      `SELECT local_id FROM external_refs WHERE connection_id=$1 AND entity_type='label'`, [connectionId]);
    return new Set(rows.map((r) => String(r.local_id)));
  }

  /**
   * Приводит метки задачи к состоянию стикеров YouGile.
   * Снимаем только «свои» метки — поставленные руками в CRM не трогаем.
   */
  async syncTaskLabels(tenantId: string, taskId: string, desired: string[], owned: Set<string>): Promise<void> {
    const current = (await this.db.many<{ label_id: string }>(
      `SELECT label_id FROM task_labels WHERE tenant_id=$1 AND task_id=$2`, [tenantId, taskId]))
      .map((r) => String(r.label_id));
    const want = new Set(desired.map(String));
    const have = new Set(current);

    for (const id of want) {
      if (have.has(id)) continue;
      await this.db.query(
        `INSERT INTO task_labels (tenant_id, task_id, label_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [tenantId, taskId, id]);
    }
    for (const id of have) {
      if (want.has(id) || !owned.has(id)) continue; // чужую (ручную) метку не снимаем
      await this.db.query(`DELETE FROM task_labels WHERE tenant_id=$1 AND task_id=$2 AND label_id=$3`, [tenantId, taskId, id]);
    }
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

  // ── E4: очередь выгрузки CRM → YouGile ──

  /** Берёт пачку ждущих операций и помечает их «в отправке» (SKIP LOCKED — безопасно при нескольких инстансах). */
  claimOutbox(limit: number): Promise<OutboxRow[]> {
    return this.db.many<OutboxRow>(
      `UPDATE integration_outbox o SET status='sending', attempts=attempts+1, updated_at=now()
        WHERE o.id IN (
          SELECT id FROM integration_outbox
           WHERE status='pending' AND next_attempt_at<=now()
           ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING o.*`,
      [limit],
    );
  }
  async outboxDone(id: string): Promise<void> {
    await this.db.query(`UPDATE integration_outbox SET status='done', last_error=NULL, updated_at=now() WHERE id=$1`, [id]);
  }
  /** Неудача: либо повтор с бэкоффом, либо окончательная ошибка (её видно в UI). */
  async outboxFail(id: string, error: string, retryInSec: number | null): Promise<void> {
    if (retryInSec === null) {
      await this.db.query(`UPDATE integration_outbox SET status='error', last_error=$2, updated_at=now() WHERE id=$1`, [id, error.slice(0, 500)]);
      return;
    }
    await this.db.query(
      `UPDATE integration_outbox SET status='pending', last_error=$2, next_attempt_at=now() + ($3 || ' seconds')::interval, updated_at=now()
        WHERE id=$1`,
      [id, error.slice(0, 500), String(retryInSec)],
    );
  }
  /** Перезапуск приложения: «в отправке» без ответа → снова в очередь. */
  async outboxRequeueStuck(): Promise<void> {
    await this.db.query(`UPDATE integration_outbox SET status='pending', updated_at=now() WHERE status='sending'`);
  }
  async outboxStats(tenantId: string, connectionId: string) {
    const rows = await this.db.many<{ status: string; n: string }>(
      `SELECT status, COUNT(*)::text AS n FROM integration_outbox WHERE tenant_id=$1 AND connection_id=$2 GROUP BY status`,
      [tenantId, connectionId]);
    const by = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0);
    const last = await this.db.one<{ last_error: string; updated_at: Date; kind: string }>(
      `SELECT kind, last_error, updated_at FROM integration_outbox
        WHERE tenant_id=$1 AND connection_id=$2 AND status='error' ORDER BY updated_at DESC LIMIT 1`,
      [tenantId, connectionId]);
    return {
      pending: by('pending') + by('sending'), done: by('done'), errors: by('error'),
      lastError: last ? { kind: last.kind, message: last.last_error, at: last.updated_at } : null,
    };
  }
  connectionById(id: string): Promise<ConnectionRow | null> {
    return this.db.one<ConnectionRow>(`SELECT * FROM integration_connections WHERE id=$1`, [id]);
  }

  // ── E4: чтение локальных объектов для выгрузки ──
  taskForPush(tenantId: string, id: string) {
    return this.db.one<PushTaskRow>(
      `SELECT id, project_id, column_id, title, description, assignee_id, priority, deadline_at, closed_at
         FROM tasks WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }
  columnForPush(tenantId: string, id: string) {
    return this.db.one<{ id: string; project_id: string; name: string }>(
      `SELECT id, project_id, name FROM board_columns WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }
  projectName(tenantId: string, id: string) {
    return this.db.one<{ name: string }>(`SELECT name FROM projects WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }
  commentForPush(tenantId: string, id: string) {
    return this.db.one<{ id: string; task_id: string; body: string; author_name: string | null }>(
      `SELECT c.id, c.task_id, c.body, u.full_name AS author_name
         FROM task_comments c LEFT JOIN users u ON u.id=c.author_id
        WHERE c.tenant_id=$1 AND c.id=$2`, [tenantId, id]);
  }
  attachmentForPush(tenantId: string, fileId: string) {
    return this.db.one<{ task_id: string; file_id: string; file_name: string; content_type: string }>(
      `SELECT a.task_id, a.file_id, f.file_name, f.content_type
         FROM task_attachments a JOIN files f ON f.id=a.file_id
        WHERE a.tenant_id=$1 AND a.file_id=$2 LIMIT 1`, [tenantId, fileId]);
  }
  userEmail(tenantId: string, id: string) {
    return this.db.one<{ email: string | null }>(`SELECT email FROM users WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
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
