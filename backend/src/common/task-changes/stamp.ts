import { DbService } from '../../database/db.service';

/** Откуда изменение задачи (ТЗ-32, §21). */
export type TransitionSource = 'MANUAL' | 'AI' | 'AUTOMATION' | 'API' | 'IMPORT';

/**
 * Кто изменил задачу (ТЗ-32). Переходы этапов и смену полей пишут триггеры базы —
 * автора они не знают; дописываем его в свежие, ещё не помеченные записи этой задачи.
 * Действие ИИ — actor_type SYSTEM_AGENT, автор — человек, который его запустил.
 */
export async function stampTaskChanges(db: DbService, tenantId: string, taskId: string, actorId: string | null, source: TransitionSource): Promise<void> {
  const vals = [tenantId, taskId, actorId, source, source === 'AI' ? 'SYSTEM_AGENT' : 'USER'];
  for (const table of ['task_status_transitions', 'task_field_changes']) {
    await db.query(
      `UPDATE ${table}
          SET actor_user_id = COALESCE(actor_user_id, $3::bigint), source = $4, actor_type = $5
        WHERE tenant_id = $1 AND task_id = $2 AND source = 'AUTOMATION' AND actor_user_id IS NULL
          AND changed_at > clock_timestamp() - interval '30 seconds'`,
      vals,
    );
  }
}
