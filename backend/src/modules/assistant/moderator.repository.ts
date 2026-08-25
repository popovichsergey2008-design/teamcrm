import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { REVIEW_COLUMN_NAMES } from '../tasks/task-columns';

export interface DueEvent {
  id: string;
  tenant_id: string;
  title: string;
  description: string | null;
  starts_at: Date;
  ends_at: Date;
  location: string | null;
  meet_room_id: string | null;
  owner_id: string;
}

@Injectable()
export class ModeratorRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Встречи, которые вот-вот начнутся и ещё без повестки.
   *
   * Окно, а не точка: планировщик ходит раз в минуту и может пропустить тик под
   * нагрузкой. Повестку на ЭТО начало не собирали — сравниваем со `starts_at`,
   * поэтому перенос встречи заставит собрать её заново.
   *
   * События на весь день пропускаем: у «отпуск Петра» повестки не бывает.
   * Встречи в одиночку — тоже: повестка самому себе это заметка, а не повестка.
   */
  dueEvents(fromMinutes: number, toMinutes: number): Promise<DueEvent[]> {
    return this.db.many<DueEvent>(
      `SELECT e.id, e.tenant_id, e.title, e.description, e.starts_at, e.ends_at,
              e.location, e.meet_room_id, e.owner_id
         FROM calendar_events e
         JOIN tenants t ON t.id = e.tenant_id AND t.assistant_mode <> 'off'
        WHERE e.all_day = FALSE
          AND e.starts_at BETWEEN now() + make_interval(mins => $1::int)
                              AND now() + make_interval(mins => $2::int)
          AND (SELECT count(*) FROM calendar_participants p
                WHERE p.event_id = e.id AND p.status <> 'declined') > 1
          AND NOT EXISTS (
            SELECT 1 FROM meeting_agendas a
             WHERE a.event_id = e.id AND a.starts_at = e.starts_at)
        LIMIT 50`,
      [fromMinutes, toMinutes],
    );
  }

  /** Кто идёт на встречу. Отказавшихся не зовём — им повестка ни к чему. */
  participants(eventId: string): Promise<{ user_id: string; full_name: string }[]> {
    return this.db.many<{ user_id: string; full_name: string }>(
      `SELECT p.user_id, u.full_name
         FROM calendar_participants p
         JOIN users u ON u.id = p.user_id AND u.is_active
        WHERE p.event_id = $1 AND p.status <> 'declined'
        ORDER BY p.is_organizer DESC, u.full_name`,
      [eventId],
    );
  }

  /**
   * Чем закончилась прошлая встреча этой же серии.
   *
   * Серию узнаём по названию события: повторяющихся событий у нас нет, а планёрку
   * заводят с тем же названием каждую неделю. Требуем общего участника — иначе
   * «Созвон» одной команды принесёт решения совсем другой.
   */
  async previousDecisions(tenantId: string, eventId: string): Promise<string[]> {
    const row = await this.db.one<{ decisions: string[] }>(
      `SELECT s.decisions
         FROM meeting_summaries s
         JOIN meetings m ON m.id = s.meeting_id
         JOIN calendar_events prev ON prev.id = m.event_id
        WHERE m.tenant_id = $1
          AND prev.id <> $2::bigint
          AND prev.title = (SELECT title FROM calendar_events WHERE id = $2::bigint)
          AND prev.starts_at < now()
          AND EXISTS (
            SELECT 1 FROM calendar_participants a
             JOIN calendar_participants b ON b.user_id = a.user_id AND b.event_id = $2::bigint
             WHERE a.event_id = prev.id)
        ORDER BY prev.starts_at DESC
        LIMIT 1`,
      [tenantId, eventId],
    );
    // decisions лежат JSONB-массивом строк; чужой формат внутрь повестки не пускаем
    return (Array.isArray(row?.decisions) ? row!.decisions : [])
      .filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
      .slice(0, 4);
  }

  /**
   * Сдано на проверку внутри этого состава: исполнитель и постановщик оба на встрече.
   *
   * Именно такие задачи и решаются голосом за минуту, а в переписке висят неделями.
   */
  awaitingReview(tenantId: string, userIds: string[]) {
    return this.db.many<{ title: string; assignee: string | null; reviewer: string | null }>(
      `SELECT t.title, a.full_name AS assignee, c.full_name AS reviewer
         FROM tasks t
         JOIN board_columns bc ON bc.id = t.column_id
         JOIN projects p ON p.id = t.project_id AND p.status <> 'archived'
         LEFT JOIN users a ON a.id = t.assignee_id
         LEFT JOIN users c ON c.id = t.created_by
        WHERE t.tenant_id = $1 AND t.closed_at IS NULL
          AND lower(bc.name) = ANY($3::text[])
          AND t.assignee_id = ANY($2::bigint[])
          AND t.created_by = ANY($2::bigint[])
        ORDER BY t.updated_at
        LIMIT 4`,
      [tenantId, userIds, REVIEW_COLUMN_NAMES],
    );
  }

  /** Просроченное у участников: об этом на встрече спросят в любом случае. */
  overdue(tenantId: string, userIds: string[]) {
    return this.db.many<{ title: string; assignee: string | null; days: number }>(
      `SELECT t.title, u.full_name AS assignee,
              GREATEST(1, (EXTRACT(EPOCH FROM (now() - t.deadline_at)) / 86400)::int) AS days
         FROM tasks t
         JOIN projects p ON p.id = t.project_id AND p.status <> 'archived'
         LEFT JOIN users u ON u.id = t.assignee_id
        WHERE t.tenant_id = $1 AND t.closed_at IS NULL
          AND t.deadline_at < now()
          AND t.assignee_id = ANY($2::bigint[])
        ORDER BY t.deadline_at
        LIMIT 4`,
      [tenantId, userIds],
    );
  }

  /** Нерешённые согласования, где спрашивающий и отвечающий оба на встрече. */
  approvals(tenantId: string, userIds: string[]) {
    return this.db.many<{ subject: string; author: string | null; approver: string | null }>(
      `SELECT ap.subject, au.full_name AS author, an.full_name AS approver
         FROM approvals ap
         LEFT JOIN users au ON au.id = ap.author_id
         LEFT JOIN users an ON an.id = ap.approver_id
        WHERE ap.tenant_id = $1 AND ap.status = 'pending'
          AND ap.author_id = ANY($2::bigint[])
          AND ap.approver_id = ANY($2::bigint[])
        ORDER BY ap.created_at
        LIMIT 4`,
      [tenantId, userIds],
    );
  }

  /**
   * Сохранить повестку. Перенесли встречу — строка переписывается: держать историю
   * повесток незачем, а старая к новому времени успевает устареть.
   */
  async saveAgenda(input: {
    tenantId: string; eventId: string; startsAt: Date; body: string; facts: unknown;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO meeting_agendas (event_id, tenant_id, starts_at, body, facts)
       VALUES ($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT (event_id) DO UPDATE
          SET starts_at = EXCLUDED.starts_at, body = EXCLUDED.body,
              facts = EXCLUDED.facts, created_at = now()`,
      [input.eventId, input.tenantId, input.startsAt, input.body, JSON.stringify(input.facts)],
    );
  }

  /** Повестка события — её открывают из уведомления и из карточки встречи. */
  agenda(tenantId: string, eventId: string) {
    return this.db.one<{ event_id: string; body: string; facts: unknown; starts_at: Date; title: string; meet_room_id: string | null }>(
      `SELECT a.event_id, a.body, a.facts, a.starts_at, e.title, e.meet_room_id
         FROM meeting_agendas a JOIN calendar_events e ON e.id = a.event_id
        WHERE a.tenant_id = $1 AND a.event_id = $2`,
      [tenantId, eventId],
    );
  }

  /**
   * Мои ближайшие повестки: то, что начинается в течение получаса.
   *
   * Смотреть повестку встречи, которая была вчера, незачем, а вот открыть её за
   * пять минут до начала — ровно то, ради чего всё делалось.
   */
  upcomingFor(tenantId: string, userId: string) {
    return this.db.many<{ event_id: string; title: string; starts_at: Date; body: string; meet_room_id: string | null }>(
      `SELECT a.event_id, e.title, e.starts_at, a.body, e.meet_room_id
         FROM meeting_agendas a
         JOIN calendar_events e ON e.id = a.event_id AND e.starts_at = a.starts_at
         JOIN calendar_participants p ON p.event_id = e.id AND p.user_id = $2 AND p.status <> 'declined'
        WHERE a.tenant_id = $1
          AND e.starts_at BETWEEN now() - interval '15 minutes' AND now() + interval '30 minutes'
        ORDER BY e.starts_at
        LIMIT 5`,
      [tenantId, userId],
    );
  }
}
