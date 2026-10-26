import { DbService } from '../../database/db.service';
import { AUTO_CONFIRM_DELAY_MS, ConfirmSource } from './auto-task';

/** Что считаем правкой постановщика: поля, которые он видит в сообщении. */
export const SNAP_SQL = "md5(concat_ws('|', t.title, t.description, t.assignee_id, t.project_id, t.deadline_at, t.priority))";

/** Что запомнить к сообщению: почему такой проект и исполнитель и откуда задача. */
export interface AutoConfirmInfo {
  projectWhy: string | null;
  assigneeWhy: string | null;
  noLeadFor?: string | null;
  /** Откуда задача (#4665): быстрая команда, голос, чат, бот… — ключ CONFIRM_SOURCES. */
  source?: ConfirmSource | null;
}

/**
 * «Задача поставлена — проверьте» через 30 секунд — запомнить в базе (#4615, #4665).
 *
 * Отдельный файл без сервисов: путей постановки через ИИ много (чат, бот, итоги
 * встречи, обещания, утренняя сводка), и тянуть ради одной вставки модуль быстрой
 * команды в каждый — круговые зависимости модулей. Сообщение отправляет тик
 * AutoConfirmService. Одна задача — одно сообщение: если путь прошёл и через
 * /nl/apply, и через свой сервис, вторая запись ничего не добавляет.
 */
export async function scheduleAutoConfirm(
  db: DbService, tenantId: string, userId: string, taskId: string, info: AutoConfirmInfo,
): Promise<string | null> {
  const row = await db.one<{ due_at: Date }>(
    `INSERT INTO task_auto_confirm (task_id, tenant_id, user_id, due_at, snap, info)
     SELECT t.id, t.tenant_id, $3, now() + make_interval(secs => $4), ${SNAP_SQL}, $5::jsonb
       FROM tasks t WHERE t.tenant_id=$1 AND t.id=$2
     ON CONFLICT (task_id) DO NOTHING
     RETURNING due_at`,
    [tenantId, taskId, userId, AUTO_CONFIRM_DELAY_MS / 1000, JSON.stringify(info)],
  );
  return row ? new Date(row.due_at).toISOString() : null;
}
