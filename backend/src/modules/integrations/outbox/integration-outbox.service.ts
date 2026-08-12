import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../../database/db.service';

/** Типы исходящих операций (CRM → внешняя система). */
export type OutboxKind =
  | 'task.create' | 'task.update' | 'task.move'
  | 'comment.create' | 'attachment.create'
  | 'column.create' | 'column.rename' | 'column.delete';

/**
 * Сторона ПОСТАНОВКИ в очередь выгрузки. Знает только про БД — поэтому её может
 * дёргать любой доменный модуль (задачи, карточка, проекты), не завися от интеграций
 * и не создавая циклов модулей. Отправку делает воркер провайдера (YougileOutboundService).
 *
 * Операция ставится, только если проект импортирован из подключения с включённой
 * двусторонней синхронизацией (push_enabled) — для обычных проектов это no-op.
 */
@Injectable()
export class IntegrationOutboxService {
  private readonly log = new Logger('IntegrationOutbox');

  constructor(private readonly db: DbService) {}

  /** Ставит операцию по проекту. Никогда не бросает: сбой выгрузки не должен ронять действие в CRM. */
  async enqueue(tenantId: string, projectId: string, kind: OutboxKind, localId: string, payload?: unknown): Promise<void> {
    try {
      const conn = await this.db.one<{ id: string }>(
        `SELECT c.id FROM projects p
           JOIN integration_connections c ON c.id = p.origin_connection_id
          WHERE p.tenant_id=$1 AND p.id=$2 AND c.is_active AND c.push_enabled`,
        [tenantId, projectId],
      );
      if (!conn) return; // локальный проект или выгрузка выключена
      // Схлопываем дубли: воркер читает актуальное состояние из БД, поэтому
      // несколько ждущих правок одного объекта одного вида не нужны.
      await this.db.query(
        `INSERT INTO integration_outbox (tenant_id, connection_id, kind, local_id, payload)
         SELECT $1,$2,$3,$4,$5
          WHERE NOT EXISTS (
            SELECT 1 FROM integration_outbox
             WHERE connection_id=$2 AND kind=$3 AND local_id=$4 AND status='pending')`,
        [tenantId, conn.id, kind, localId, payload == null ? null : JSON.stringify(payload)],
      );
    } catch (e) {
      this.log.warn(`enqueue ${kind} ${localId} failed: ${(e as Error).message}`);
    }
  }

  /** То же, но проект берётся из задачи (у карточки/комментариев на руках только taskId). */
  async enqueueForTask(tenantId: string, taskId: string, kind: OutboxKind, localId?: string, payload?: unknown): Promise<void> {
    try {
      const row = await this.db.one<{ project_id: string }>(
        `SELECT project_id FROM tasks WHERE tenant_id=$1 AND id=$2`, [tenantId, taskId]);
      if (!row) return;
      await this.enqueue(tenantId, row.project_id, kind, localId ?? taskId, payload);
    } catch (e) {
      this.log.warn(`enqueueForTask ${kind} ${taskId} failed: ${(e as Error).message}`);
    }
  }
}
