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
  /** Состав сводки: задачи, о которых она говорит (задача #1368). У обычных поводов — null. */
  items: { taskId: string; title: string; kind: string; mine: boolean }[] | null;
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

  /** Предлагать ли уборку — показываем рядом с режимом, чтобы настройки жили в одном месте. */
  async maintenance(tenantId: string): Promise<boolean> {
    const row = await this.db.one<{ maintenance_enabled: boolean }>(
      `SELECT maintenance_enabled FROM tenants WHERE id = $1`, [tenantId],
    );
    return row?.maintenance_enabled !== false;
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
                t.id::text AS "subjectId",
                t.title, t.project_name AS "projectName", t.project_id::text AS "projectId",
                EXTRACT(EPOCH FROM (now() - t.deadline_at)) / 3600 AS hours, u.timezone
           FROM live t JOIN users u ON u.id = t.assignee_id AND u.is_active
          WHERE t.deadline_at < now() AND lower(t.column_name) <> ALL($2::text[])
         UNION ALL
         SELECT 'due_soon', t.assignee_id::text, t.id::text, t.id::text, t.title, t.project_name, t.project_id::text,
                EXTRACT(EPOCH FROM (t.deadline_at - now())) / 3600, u.timezone
           FROM live t JOIN users u ON u.id = t.assignee_id AND u.is_active
          WHERE t.deadline_at BETWEEN now() AND now() + interval '24 hours'
            AND lower(t.column_name) <> ALL($2::text[])
         UNION ALL
         SELECT 'stuck_review', t.created_by::text, t.id::text, t.id::text, t.title, t.project_name, t.project_id::text,
                EXTRACT(EPOCH FROM (now() - t.updated_at)) / 3600, u.timezone
           FROM live t JOIN users u ON u.id = t.created_by AND u.is_active
          WHERE lower(t.column_name) = ANY($2::text[])
            AND t.updated_at < now() - make_interval(hours => $3::int)
         UNION ALL
         SELECT 'silent', t.assignee_id::text, t.id::text, t.id::text, t.title, t.project_name, t.project_id::text,
                EXTRACT(EPOCH FROM (now() - t.updated_at)) / 3600, u.timezone
           FROM live t JOIN users u ON u.id = t.assignee_id AND u.is_active
          WHERE t.deadline_at IS NULL
            AND lower(t.column_name) <> ALL($2::text[])
            AND t.updated_at < now() - make_interval(days => $4::int)
         UNION ALL
         -- Согласование, которое ждёт решения. Забывается чаще срока: у задачи есть
         -- доска и календарь, а у вопроса «подтверди» — только тот, кто его задал.
         SELECT 'approval_stuck', a.approver_id::text, a.task_id::text, a.id::text,
                a.subject, NULL, (SELECT t.project_id::text FROM tasks t WHERE t.id = a.task_id),
                EXTRACT(EPOCH FROM (now() - a.created_at)) / 3600, u.timezone
           FROM approvals a JOIN users u ON u.id = a.approver_id AND u.is_active
          WHERE a.tenant_id = $1 AND a.status = 'pending'
            AND a.created_at < now() - make_interval(hours => $3::int)
         UNION ALL
         -- Позвали в ленте и не дождались ответа. Ответом считаем ЛЮБОЙ его комментарий
         -- к этому посту после упоминания: «прочитал и промолчал» и «ответил» — разное.
         SELECT 'mention_silent', m.user_id::text, NULL, m.id::text,
                left(fp.body, 80), NULL, NULL,
                EXTRACT(EPOCH FROM (now() - m.created_at)) / 3600, u.timezone
           FROM feed_mentions m
           JOIN feed_posts fp ON fp.id = m.post_id
           JOIN users u ON u.id = m.user_id AND u.is_active
          WHERE m.tenant_id = $1
            AND m.created_at < now() - make_interval(hours => $3::int)
            AND NOT EXISTS (
              SELECT 1 FROM feed_comments fc
               WHERE fc.post_id = m.post_id AND fc.author_id = m.user_id
                 AND fc.created_at > m.created_at
            )
       ) c
       ORDER BY hours DESC
       LIMIT 200`,
      [tenantId, REVIEW_COLUMN_NAMES, stuckHours, silentDays],
    );
  }

  /**
   * Записать пинг. Ключ повода уникален — повторное появление того же повода
   * обновляет ту же строку, а не заводит новую.
   */
  create(input: {
    tenantId: string; userId: string; kind: string; taskId: string | null; text: string;
    status: 'proposed' | 'sent'; dedupKey: string;
    /** Состав сводки: задачи, о которых она говорит (задача #1368). */
    items?: unknown;
  }): Promise<{ id: string } | null> {
    // Время отправки считаем здесь, а не в SQL: тот же параметр в роли значения
    // колонки И в сравнении внутри CASE Postgres отказывается типизировать —
    // «inconsistent types deduced for parameter», и весь проход планировщика падал.
    const sentAt = input.status === 'sent' ? new Date() : null;
    return this.db.one<{ id: string }>(
      `INSERT INTO assistant_pings (tenant_id, user_id, kind, task_id, text, status, dedup_key, last_sent_at, items)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT (tenant_id, dedup_key) DO NOTHING
       RETURNING id`,
      [
        input.tenantId, input.userId, input.kind, input.taskId, input.text, input.status,
        input.dedupKey, sentAt, input.items ? JSON.stringify(input.items) : null,
      ],
    );
  }

  /**
   * Отклик по видам поводов за окно наблюдения.
   *
   * «Ответил делом» — это статус `done`: человек нажал «Сделаю сегодня». «Скрыть»
   * сюда не идёт намеренно: закрыть надоевшее напоминание — не то же самое, что
   * заняться работой, и считать это успехом значило бы обманывать себя.
   */
  reactionStats(tenantId: string, days: number): Promise<{ kind: string; sent: string; acted: string }[]> {
    return this.db.many(
      `SELECT kind,
              COUNT(*) FILTER (WHERE status <> 'proposed') AS sent,
              COUNT(*) FILTER (WHERE status = 'done') AS acted
         FROM assistant_pings
        WHERE tenant_id=$1 AND created_at > now() - make_interval(days => $2::int)
          AND kind NOT IN ('digest','evening')
        GROUP BY kind`,
      [tenantId, days],
    );
  }

  /** Строка повода, если он уже заводился: по ней решаем, пора ли повторять. */
  byKey(tenantId: string, dedupKey: string): Promise<{
    id: string; status: string; repeats: number; last_sent_at: Date | null;
  } | null> {
    return this.db.one(
      `SELECT id, status, repeats, last_sent_at FROM assistant_pings
        WHERE tenant_id=$1 AND dedup_key=$2`,
      [tenantId, dedupKey],
    );
  }

  /**
   * Повторить повод: тот же текст мог устареть («срок прошёл 2 дня» → «5 дней»),
   * поэтому переписываем его целиком и поднимаем счётчик повторов.
   */
  async repeat(tenantId: string, id: string, text: string, status: 'proposed' | 'sent'): Promise<void> {
    const sentAt = status === 'sent' ? new Date() : null;
    await this.db.query(
      `UPDATE assistant_pings
          SET text=$3, status=$4, repeats=repeats+1, resolved_at=NULL,
              last_sent_at = COALESCE($5::timestamptz, last_sent_at),
              created_at=now()
        WHERE tenant_id=$1 AND id=$2`,
      [tenantId, id, text.slice(0, 300), status, sentAt],
    );
  }

  /**
   * Мои напоминания. Закрытые задачи отсеиваем на чтении, а не чистим планировщиком:
   * человек закрыл задачу через минуту после пинга — напоминание должно исчезнуть само.
   */
  listForUser(tenantId: string, userId: string): Promise<PingRow[]> {
    return this.db.many<PingRow>(
      `SELECT pg.id, pg.kind, pg.task_id, pg.text, pg.status, pg.created_at, pg.items,
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

  async setStatus(tenantId: string, id: string, status: 'sent' | 'dismissed' | 'done'): Promise<void> {
    await this.db.query(
      // тип параметра задаём явно: один и тот же $3 стоит и справа от status (varchar),
      // и в сравнении — без приведения Postgres выводит для него два разных типа и падает
      `UPDATE assistant_pings
          SET status = $3::text,
              resolved_at = CASE WHEN $3::text IN ('dismissed', 'done') THEN now() ELSE resolved_at END
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id, status],
    );
  }
}
