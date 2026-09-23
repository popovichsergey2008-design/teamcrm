import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface BatchRow {
  id: string;
  tenant_id: string;
  user_id: string;
  source_type: string;
  source_text: string | null;
  status: string;
  requested_count: number;
  created_count: number;
  failed_count: number;
  client_request_id: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface BatchItemRow {
  id: string;
  batch_id: string;
  position: number;
  task_id: string | null;
  status: string;
  error_message: string | null;
  draft: Record<string, unknown>;
}

/** Задача пакета глазами экрана результата: без лишних полей, но со всем, что показываем. */
export interface BatchTaskRow {
  task_id: string;
  title: string;
  project_id: string;
  project_name: string | null;
  assignee_id: string | null;
  assignee_name: string | null;
  deadline_at: string | null;
  priority: string | null;
  status: string | null;
}

/**
 * Хранилище пакетов быстрой команды (ТЗ-10, этап 2).
 *
 * Пакет — это не «список id в памяти окна», а запись: по ней экран результата
 * открывается снова после перезагрузки и по ссылке, а повторное нажатие «создать»
 * не плодит дубли.
 */
@Injectable()
export class BatchRepository {
  constructor(private readonly db: DbService) {}

  /** Пакет по ключу запроса — им закрывается повтор после обрыва связи. */
  byRequestId(tenantId: string, clientRequestId: string) {
    return this.db.one<BatchRow>(
      `SELECT * FROM quick_command_batches WHERE tenant_id=$1 AND client_request_id=$2`,
      [tenantId, clientRequestId],
    );
  }

  byId(tenantId: string, id: string) {
    return this.db.one<BatchRow>(
      `SELECT * FROM quick_command_batches WHERE tenant_id=$1 AND id=$2`, [tenantId, id],
    );
  }

  create(i: {
    tenantId: string; userId: string; sourceType: string; sourceText: string | null;
    requested: number; clientRequestId: string | null;
  }) {
    return this.db.one<BatchRow>(
      `INSERT INTO quick_command_batches
         (tenant_id, user_id, source_type, source_text, requested_count, client_request_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING
       RETURNING *`,
      [i.tenantId, i.userId, i.sourceType, i.sourceText, i.requested, i.clientRequestId],
    );
  }

  addItem(i: {
    batchId: string; position: number; taskId: string | null; status: string;
    error: string | null; draft: unknown;
  }) {
    return this.db.one<BatchItemRow>(
      `INSERT INTO quick_command_batch_items (batch_id, position, task_id, status, error_message, draft)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)
       ON CONFLICT (batch_id, position) DO UPDATE SET
         task_id=EXCLUDED.task_id, status=EXCLUDED.status,
         error_message=EXCLUDED.error_message, draft=EXCLUDED.draft
       RETURNING *`,
      [i.batchId, i.position, i.taskId, i.status, i.error, JSON.stringify(i.draft ?? {})],
    );
  }

  items(batchId: string) {
    return this.db.many<BatchItemRow>(
      `SELECT * FROM quick_command_batch_items WHERE batch_id=$1 ORDER BY position`, [batchId],
    );
  }

  item(batchId: string, itemId: string) {
    return this.db.one<BatchItemRow>(
      `SELECT * FROM quick_command_batch_items WHERE batch_id=$1 AND id=$2`, [batchId, itemId],
    );
  }

  /** Пересчитать итоги: считаем по самим элементам, а не по счётчикам в памяти. */
  finish(batchId: string) {
    return this.db.one<BatchRow>(
      `UPDATE quick_command_batches b SET
         created_count = (SELECT count(*) FROM quick_command_batch_items i WHERE i.batch_id=b.id AND i.status='created'),
         failed_count  = (SELECT count(*) FROM quick_command_batch_items i WHERE i.batch_id=b.id AND i.status='failed'),
         status = CASE
           WHEN (SELECT count(*) FROM quick_command_batch_items i WHERE i.batch_id=b.id AND i.status='created') = 0 THEN 'failed'
           WHEN (SELECT count(*) FROM quick_command_batch_items i WHERE i.batch_id=b.id AND i.status='failed') > 0 THEN 'partial'
           ELSE 'completed' END,
         completed_at = now()
       WHERE b.id=$1
       RETURNING *`,
      [batchId],
    );
  }

  /** Созданные задачи пакета — как их показывает экран результата. */
  tasks(batchId: string) {
    return this.db.many<BatchTaskRow>(
      `SELECT i.task_id::text, t.title, t.project_id::text, p.name AS project_name,
              t.assignee_id::text, u.full_name AS assignee_name,
              t.deadline_at, t.priority, c.name AS status
         FROM quick_command_batch_items i
         JOIN tasks t ON t.id = i.task_id
         LEFT JOIN projects p ON p.id = t.project_id
         LEFT JOIN users u ON u.id = t.assignee_id
         LEFT JOIN board_columns c ON c.id = t.column_id
        WHERE i.batch_id=$1 AND i.task_id IS NOT NULL
        ORDER BY i.position`,
      [batchId],
    );
  }

  /** Пометить задачу как рождённую пакетом: видно и в карточке, и в отчётах. */
  async linkTask(taskId: string, batchId: string) {
    await this.db.query(`UPDATE tasks SET source_batch_id=$2 WHERE id=$1`, [taskId, batchId]);
  }
}
