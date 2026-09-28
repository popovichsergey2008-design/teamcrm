import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { FollowupAnswer } from './followup-rules';
import { REVIEW_COLUMN_NAMES } from './task-columns';

export interface FollowupCandidate {
  tenant_id: string;
  task_id: string;
  project_id: string;
  title: string;
  deadline_at: string;
  closed: boolean;
  waiting_approval: boolean;
  assignee_id: string | null;
  /** Пояс исполнителя и рабочий календарь компании: спрашиваем только в рабочее время. */
  timezone: string | null;
  org_timezone: string | null;
  work_start: string;
  work_end: string;
  weekend_days: number[];
  holidays: string[];
  asked: boolean;
}

export interface FollowupRow {
  id: string;
  task_id: string;
  user_id: string;
  deadline_at: string;
  answer: FollowupAnswer | null;
  ping_id: string | null;
}

/**
 * Догоняющий вопрос: кого пора спросить и что он ответил.
 *
 * Строку напоминания заводим здесь же, своим запросом, а не через модуль ассистента:
 * нужен один INSERT, а связывать ради него два модуля — плата больше пользы.
 */
@Injectable()
export class FollowupsRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Задачи, у которых срок в ближайшие часы.
   *
   * Берём окно с запасом (до шести часов) и отсеиваем точнее уже в чистых правилах:
   * «спрашивать или нет» — это решение, а не выборка, и ему место там, где его можно
   * проверить без базы.
   */
  due(now: Date, windowMs: number, limit = 200): Promise<FollowupCandidate[]> {
    return this.db.many<FollowupCandidate>(
      `SELECT t.tenant_id::text, t.id::text AS task_id, t.project_id::text, t.title,
              t.deadline_at, (t.closed_at IS NOT NULL) AS closed,
              -- «Сдана и ждёт приёмки» определяем по КОЛОНКЕ: у нас нет отдельного
              -- статуса, а имена стадии свои у каждой импортированной доски.
              (lower(c.name) = ANY($4::text[])) AS waiting_approval,
              t.assignee_id::text, u.timezone, org.timezone AS org_timezone,
              COALESCE(w.work_start, TIME '09:00')::text AS work_start,
              COALESCE(w.work_end, TIME '18:00')::text AS work_end,
              COALESCE(w.weekend_days, ARRAY[0,6]) AS weekend_days,
              COALESCE(w.holidays, ARRAY[]::date[])::text[] AS holidays,
              EXISTS (
                SELECT 1 FROM task_followups f
                 WHERE f.task_id = t.id AND f.deadline_at = t.deadline_at
              ) AS asked
         FROM tasks t
         JOIN tenants org ON org.id = t.tenant_id
         LEFT JOIN users u ON u.id = t.assignee_id
         LEFT JOIN org_work_settings w ON w.tenant_id = t.tenant_id
         LEFT JOIN board_columns c ON c.id = t.column_id
         JOIN projects p ON p.id = t.project_id AND p.status <> 'archived'
        WHERE t.deadline_at IS NOT NULL
          AND t.closed_at IS NULL
          AND t.deleted_at IS NULL
          AND t.assignee_id IS NOT NULL
          AND t.deadline_at > $1::timestamptz
          AND t.deadline_at <= $1::timestamptz + ($2::bigint || ' milliseconds')::interval
        ORDER BY t.deadline_at
        LIMIT $3`,
      [now.toISOString(), String(windowMs), limit, REVIEW_COLUMN_NAMES],
    );
  }

  /**
   * Записать, что спросили.
   *
   * Возвращает false, если строка уже была: во время выкладки недолго живут два
   * экземпляра приложения, и оба могут взять одну задачу.
   */
  async remember(
    tenantId: string, taskId: string, userId: string, deadlineAt: string, pingId: string | null,
  ): Promise<boolean> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO task_followups (tenant_id, task_id, user_id, deadline_at, ping_id)
            VALUES ($1, $2, $3, $4, $5::bigint)
       ON CONFLICT (task_id, deadline_at) DO NOTHING
         RETURNING id::text`,
      [tenantId, taskId, userId, deadlineAt, pingId],
    );
    return !!row;
  }

  /** Напоминание с вопросом — той же таблицей, что и прочие поводы ассистента. */
  async addPing(input: {
    tenantId: string; userId: string; taskId: string; text: string; dedupKey: string;
  }): Promise<string | null> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO assistant_pings (tenant_id, user_id, kind, task_id, text, status, dedup_key, last_sent_at)
            VALUES ($1, $2, 'followup', $3, $4, 'sent', $5, now())
       ON CONFLICT (tenant_id, dedup_key) DO NOTHING
         RETURNING id::text`,
      [input.tenantId, input.userId, input.taskId, input.text, input.dedupKey],
    );
    return row?.id ?? null;
  }

  /** Открытый вопрос по задаче: на него и отвечают. */
  open(tenantId: string, taskId: string, userId: string): Promise<FollowupRow | null> {
    return this.db.one<FollowupRow>(
      `SELECT id::text, task_id::text, user_id::text, deadline_at, answer, ping_id::text
         FROM task_followups
        WHERE tenant_id = $1 AND task_id = $2 AND user_id = $3 AND answer IS NULL
        ORDER BY asked_at DESC LIMIT 1`,
      [tenantId, taskId, userId],
    );
  }

  async saveAnswer(id: string, answer: FollowupAnswer): Promise<void> {
    await this.db.query(
      `UPDATE task_followups SET answer = $2, answered_at = now() WHERE id = $1`,
      [id, answer],
    );
  }

  /** Ответили — строка в сводке больше не нужна. */
  async resolvePing(pingId: string | null): Promise<void> {
    if (!pingId) return;
    await this.db.query(
      `UPDATE assistant_pings SET status = 'dismissed', resolved_at = now() WHERE id = $1`,
      [pingId],
    );
  }
}
