import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { REVIEW_COLUMN_NAMES } from '../tasks/task-columns';
import { PingCandidate, WorkHours } from './ping-rules';

export type AssistantMode = 'off' | 'copilot' | 'autopilot';

export interface PingRow {
  id: string;
  kind: string;
  task_id: string | null;
  text: string;
  status: string;
  created_at: Date;
  project_id: string | null;
  assignee_name: string | null;
  user_name: string | null;
}

/** Рабочие часы по умолчанию — те же, что в календаре: организация их могла и не задавать. */
const DEFAULT_WORK: WorkHours = { workStart: '09:00', workEnd: '18:00', weekendDays: [0, 6], holidays: [] };

@Injectable()
export class AssistantRepository {
  constructor(private readonly db: DbService) {}

  /** Организации, где ассистент включён. Выключенные не опрашиваем вовсе. */
  activeTenants(): Promise<{ id: string; assistant_mode: AssistantMode }[]> {
    return this.db.many<{ id: string; assistant_mode: AssistantMode }>(
      `SELECT id, assistant_mode FROM tenants WHERE assistant_mode <> 'off'`,
    );
  }

  async mode(tenantId: string): Promise<AssistantMode> {
    const row = await this.db.one<{ assistant_mode: AssistantMode }>(
      `SELECT assistant_mode FROM tenants WHERE id = $1`, [tenantId],
    );
    return row?.assistant_mode ?? 'copilot';
  }

  async setMode(tenantId: string, mode: AssistantMode): Promise<AssistantMode> {
    await this.db.query(`UPDATE tenants SET assistant_mode = $2 WHERE id = $1`, [tenantId, mode]);
    return mode;
  }

  /** Создавать ли задачи со встречи сразу — настройка компании, рядом с режимом. */
  async autoTasks(tenantId: string): Promise<boolean> {
    const row = await this.db.one<{ meeting_auto_tasks: boolean }>(
      `SELECT meeting_auto_tasks FROM tenants WHERE id = $1`, [tenantId],
    );
    return row?.meeting_auto_tasks !== false;
  }

  async setAutoTasks(tenantId: string, enabled: boolean): Promise<boolean> {
    await this.db.query(`UPDATE tenants SET meeting_auto_tasks = $2 WHERE id = $1`, [tenantId, enabled]);
    return enabled;
  }

  async workHours(tenantId: string): Promise<WorkHours> {
    // holidays — к тексту прямо в запросе: как DATE[] драйвер отдаёт JS-даты в поясе
    // процесса, и «1 января» на сервере +3 стало бы «31 декабря»
    const row = await this.db.one<{ work_start: string; work_end: string; weekend_days: number[]; holidays: string[] }>(
      `SELECT work_start::text, work_end::text, weekend_days, holidays::text[] AS holidays
         FROM org_work_settings WHERE tenant_id = $1`,
      [tenantId],
    );
    if (!row) return DEFAULT_WORK;
    return {
      workStart: row.work_start.slice(0, 5),
      workEnd: row.work_end.slice(0, 5),
      weekendDays: row.weekend_days ?? DEFAULT_WORK.weekendDays,
      holidays: (row.holidays ?? []).map((h) => String(h).slice(0, 10)),
    };
  }

  /**
   * Поводы напомнить — одним запросом.
   *
   * Четыре повода, и все они про одно: работа стоит, а человек об этом не знает или
   * забыл. Сданное на проверку из просрочки исполнителя исключено намеренно — он своё
   * сделал, дальше очередь проверяющего, и напоминать надо ему.
   *
   * «Без движения» берём только у задач БЕЗ срока: у задачи со сроком свой повод есть,
   * и два напоминания об одной задаче в день — это уже не помощь.
   */
  candidates(tenantId: string, stuckHours: number, silentDays: number): Promise<PingCandidate[]> {
    return this.db.many<PingCandidate>(
      `WITH live AS (
         SELECT t.*, p.name AS project_name, bc.name AS column_name
           FROM tasks t
           JOIN projects p ON p.id = t.project_id AND p.status <> 'archived'
           JOIN board_columns bc ON bc.id = t.column_id
          WHERE t.tenant_id = $1 AND t.closed_at IS NULL
       )
       SELECT * FROM (
         SELECT 'overdue' AS kind, t.assignee_id::text AS "userId", t.id::text AS "taskId",
                t.title, t.project_name AS "projectName",
                EXTRACT(EPOCH FROM (now() - t.deadline_at)) / 3600 AS hours, u.timezone
           FROM live t JOIN users u ON u.id = t.assignee_id AND u.is_active
          WHERE t.deadline_at < now() AND lower(t.column_name) <> ALL($2::text[])
         UNION ALL
         SELECT 'due_soon', t.assignee_id::text, t.id::text, t.title, t.project_name,
                EXTRACT(EPOCH FROM (t.deadline_at - now())) / 3600, u.timezone
           FROM live t JOIN users u ON u.id = t.assignee_id AND u.is_active
          WHERE t.deadline_at BETWEEN now() AND now() + interval '24 hours'
            AND lower(t.column_name) <> ALL($2::text[])
         UNION ALL
         SELECT 'stuck_review', t.created_by::text, t.id::text, t.title, t.project_name,
                EXTRACT(EPOCH FROM (now() - t.updated_at)) / 3600, u.timezone
           FROM live t JOIN users u ON u.id = t.created_by AND u.is_active
          WHERE lower(t.column_name) = ANY($2::text[])
            AND t.updated_at < now() - make_interval(hours => $3::int)
         UNION ALL
         SELECT 'silent', t.assignee_id::text, t.id::text, t.title, t.project_name,
                EXTRACT(EPOCH FROM (now() - t.updated_at)) / 3600, u.timezone
           FROM live t JOIN users u ON u.id = t.assignee_id AND u.is_active
          WHERE t.deadline_at IS NULL
            AND lower(t.column_name) <> ALL($2::text[])
            AND t.updated_at < now() - make_interval(days => $4::int)
       ) c
       ORDER BY hours DESC
       LIMIT 200`,
      [tenantId, REVIEW_COLUMN_NAMES, stuckHours, silentDays],
    );
  }

  /**
   * Записать пинг. Ключ повтора уникален — второй раз за сутки по тому же поводу
   * запрос просто ничего не сделает и вернёт null.
   */
  create(input: {
    tenantId: string; userId: string; kind: string; taskId: string; text: string;
    status: 'proposed' | 'sent'; dedupKey: string;
  }): Promise<{ id: string } | null> {
    return this.db.one<{ id: string }>(
      `INSERT INTO assistant_pings (tenant_id, user_id, kind, task_id, text, status, dedup_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id, dedup_key) DO NOTHING
       RETURNING id`,
      [input.tenantId, input.userId, input.kind, input.taskId, input.text, input.status, input.dedupKey],
    );
  }

  /**
   * Мои напоминания. Закрытые задачи отсеиваем на чтении, а не чистим планировщиком:
   * человек закрыл задачу через минуту после пинга — напоминание должно исчезнуть само.
   */
  listForUser(tenantId: string, userId: string): Promise<PingRow[]> {
    return this.db.many<PingRow>(
      `SELECT pg.id, pg.kind, pg.task_id, pg.text, pg.status, pg.created_at,
              t.project_id, u.full_name AS assignee_name, NULL::text AS user_name
         FROM assistant_pings pg
         LEFT JOIN tasks t ON t.id = pg.task_id
         LEFT JOIN users u ON u.id = t.assignee_id
        WHERE pg.tenant_id = $1 AND pg.user_id = $2 AND pg.status = 'sent'
          AND (t.id IS NULL OR t.closed_at IS NULL)
        ORDER BY pg.created_at DESC
        LIMIT 20`,
      [tenantId, userId],
    );
  }

  /**
   * Что ассистент предлагает разослать (режим «копилот»).
   *
   * Показываем предложение постановщику задачи: это он сегодня ходит и спрашивает
   * «ну что там?», и решать, стоит ли дёргать человека, тоже ему.
   */
  listProposed(tenantId: string, actorId: string): Promise<PingRow[]> {
    return this.db.many<PingRow>(
      `SELECT pg.id, pg.kind, pg.task_id, pg.text, pg.status, pg.created_at,
              t.project_id, a.full_name AS assignee_name, u.full_name AS user_name
         FROM assistant_pings pg
         JOIN tasks t ON t.id = pg.task_id
         LEFT JOIN users a ON a.id = t.assignee_id
         JOIN users u ON u.id = pg.user_id
        WHERE pg.tenant_id = $1 AND pg.status = 'proposed'
          AND t.closed_at IS NULL
          AND (t.created_by = $2 OR pg.user_id = $2)
        ORDER BY pg.created_at DESC
        LIMIT 50`,
      [tenantId, actorId],
    );
  }

  byId(tenantId: string, id: string): Promise<(PingRow & { user_id: string; created_by: string | null }) | null> {
    return this.db.one<PingRow & { user_id: string; created_by: string | null }>(
      `SELECT pg.*, t.created_by
         FROM assistant_pings pg LEFT JOIN tasks t ON t.id = pg.task_id
        WHERE pg.tenant_id = $1 AND pg.id = $2`,
      [tenantId, id],
    );
  }

  async setStatus(tenantId: string, id: string, status: 'sent' | 'dismissed'): Promise<void> {
    await this.db.query(
      // тип параметра задаём явно: один и тот же $3 стоит и справа от status (varchar),
      // и в сравнении — без приведения Postgres выводит для него два разных типа и падает
      `UPDATE assistant_pings
          SET status = $3::text,
              resolved_at = CASE WHEN $3::text = 'dismissed' THEN now() ELSE resolved_at END
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id, status],
    );
  }
}
