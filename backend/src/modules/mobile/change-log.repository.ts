import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface ChangeRef {
  id: string;
  entity_type: 'task' | 'task_comment' | 'chat_message' | 'checklist_item';
  entity_id: string;
  parent_id: string | null;
  op: 'insert' | 'update' | 'delete';
  version: number | null;
  at: Date;
}

/** Сколько живёт журнал: клиент, не заходивший дольше, перечитывает всё заново. */
export const CHANGE_LOG_RETENTION_DAYS = 30;

/**
 * Журнал изменений для delta-sync (ТЗ-9, волна 9). Пишут триггеры, здесь только чтение.
 */
@Injectable()
export class ChangeLogRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Изменения после курсора, которые ЭТОТ человек вправе видеть.
   *
   * Журнал хранит только ссылки, но и ссылка — утечка: «в приватном проекте появилась
   * задача» сотруднику, которого туда не звали, знать незачем. Поэтому задачи и их
   * потроха фильтруем по видимости проекта, сообщения — по членству в чате. Удалённые
   * записи проверить уже не по чему — их отдаём как есть: id без содержимого.
   */
  async after(
    tenantId: string,
    viewer: { userId: string; role: string },
    cursor: string | null,
    limit: number,
  ): Promise<ChangeRef[]> {
    const boss = viewer.role === 'owner' || viewer.role === 'manager';
    return this.db.many<ChangeRef>(
      `WITH visible_projects AS (
         SELECT p.id FROM projects p
          WHERE p.tenant_id = $1
            AND ($3::boolean OR p.visibility = 'all' OR p.owner_user_id = $4::bigint
                 OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $4::bigint))
       )
       SELECT c.id::text, c.entity_type, c.entity_id::text, c.parent_id::text, c.op, c.version, c.at
         FROM change_log c
        WHERE c.tenant_id = $1 AND c.id > $2::bigint
          AND (
            c.op = 'delete'
            OR (c.entity_type = 'task' AND c.parent_id IN (SELECT id FROM visible_projects))
            OR (c.entity_type IN ('task_comment', 'checklist_item')
                AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = c.parent_id AND t.project_id IN (SELECT id FROM visible_projects)))
            OR (c.entity_type = 'chat_message'
                AND EXISTS (SELECT 1 FROM chat_members m WHERE m.chat_id = c.parent_id AND m.user_id = $4::bigint))
          )
        ORDER BY c.id
        LIMIT $5`,
      [tenantId, cursor ?? '0', boss, viewer.userId, limit],
    );
  }

  /** Последний номер журнала — точка, с которой клиент начинает после полной загрузки. */
  async head(tenantId: string): Promise<string> {
    const row = await this.db.one<{ id: string | null }>(
      `SELECT MAX(id)::text AS id FROM change_log WHERE tenant_id = $1`,
      [tenantId],
    );
    return row?.id ?? '0';
  }

  /** Самая старая запись — если курсор клиента старше, ему нужна полная загрузка. */
  async oldest(tenantId: string): Promise<string | null> {
    const row = await this.db.one<{ id: string | null }>(
      `SELECT MIN(id)::text AS id FROM change_log WHERE tenant_id = $1`,
      [tenantId],
    );
    return row?.id ?? null;
  }

  async prune(): Promise<number> {
    const res = await this.db.query(
      `DELETE FROM change_log WHERE at < now() - ($1 || ' days')::interval`,
      [String(CHANGE_LOG_RETENTION_DAYS)],
    );
    return res.rowCount ?? 0;
  }
}
