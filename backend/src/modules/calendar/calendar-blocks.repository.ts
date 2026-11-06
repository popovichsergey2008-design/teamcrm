import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

/** Блок своего расписания: время на задачу или запланированный фокус (#4787, п. 3, 12). */
export interface BlockRow {
  id: string;
  user_id: string;
  kind: 'task' | 'focus';
  task_id: string | null;
  task_ids: string[];
  title: string | null;
  starts_at: Date;
  ends_at: Date;
  /** задача блока — для подписи и перехода в неё (не копия: открывается сама задача) */
  task_title: string | null;
  task_project_id: string | null;
  task_project_name: string | null;
  task_deadline_at: Date | null;
  task_status: string | null;
}

@Injectable()
export class CalendarBlocksRepository {
  constructor(private readonly db: DbService) {}

  private static readonly SELECT = `
    SELECT b.id, b.user_id, b.kind, b.task_id, b.task_ids, b.title, b.starts_at, b.ends_at,
           t.title AS task_title, t.project_id AS task_project_id, p.name AS task_project_name,
           t.deadline_at AS task_deadline_at, t.status AS task_status
      FROM calendar_blocks b
      LEFT JOIN tasks t ON t.id = b.task_id AND t.deleted_at IS NULL
      LEFT JOIN projects p ON p.id = t.project_id`;

  inRange(tenantId: string, userId: string, from: string, to: string) {
    return this.db.many<BlockRow>(
      `${CalendarBlocksRepository.SELECT}
        WHERE b.tenant_id = $1 AND b.user_id = $2
          AND b.starts_at < $4::timestamptz AND b.ends_at > $3::timestamptz
          AND (b.kind <> 'task' OR t.id IS NOT NULL)
        ORDER BY b.starts_at`,
      [tenantId, userId, from, to],
    );
  }

  byId(tenantId: string, id: string) {
    return this.db.one<BlockRow>(`${CalendarBlocksRepository.SELECT} WHERE b.tenant_id = $1 AND b.id = $2`, [tenantId, id]);
  }

  /** Все блоки задачи у человека — карточка задачи показывает, когда он собирается её делать. */
  ofTask(tenantId: string, userId: string, taskId: string) {
    return this.db.many<BlockRow>(
      `${CalendarBlocksRepository.SELECT}
        WHERE b.tenant_id = $1 AND b.user_id = $2 AND b.task_id = $3 ORDER BY b.starts_at`,
      [tenantId, userId, taskId],
    );
  }

  async create(tenantId: string, userId: string, b: {
    kind: 'task' | 'focus'; taskId: string | null; taskIds: string[]; title: string | null; startsAt: string; endsAt: string;
  }): Promise<string> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO calendar_blocks (tenant_id, user_id, kind, task_id, task_ids, title, starts_at, ends_at)
       VALUES ($1, $2, $3, $4::bigint, $5::bigint[], $6, $7::timestamptz, $8::timestamptz) RETURNING id`,
      [tenantId, userId, b.kind, b.taskId, b.taskIds, b.title, b.startsAt, b.endsAt],
    );
    return String(row!.id);
  }

  move(tenantId: string, userId: string, id: string, startsAt: string, endsAt: string) {
    return this.db.query(
      `UPDATE calendar_blocks SET starts_at = $4::timestamptz, ends_at = $5::timestamptz, updated_at = now()
        WHERE tenant_id = $1 AND user_id = $2 AND id = $3`,
      [tenantId, userId, id, startsAt, endsAt],
    );
  }

  remove(tenantId: string, userId: string, id: string) {
    return this.db.query(`DELETE FROM calendar_blocks WHERE tenant_id = $1 AND user_id = $2 AND id = $3`, [tenantId, userId, id]);
  }

  /** Задача, которую человек вправе планировать: он исполнитель или постановщик. */
  ownTask(tenantId: string, userId: string, taskId: string) {
    return this.db.one<{ id: string; title: string; deadline_at: Date | null; estimate_hours: string | null; project_id: string }>(
      `SELECT t.id, t.title, t.deadline_at, t.estimate_hours, t.project_id
         FROM tasks t
        WHERE t.tenant_id = $1 AND t.id = $3 AND t.deleted_at IS NULL
          AND (t.assignee_id = $2 OR t.created_by = $2)`,
      [tenantId, userId, taskId],
    );
  }

  /**
   * Задачи для планирования (п. 4): открытые, где человек исполнитель, — сначала со сроком.
   * Сколько уже запланировано — чтобы видно было, что задача уже стоит в календаре.
   */
  toPlan(tenantId: string, userId: string) {
    return this.db.many<{
      id: string; title: string; project_id: string; project_name: string; deadline_at: Date | null;
      estimate_hours: string | null; priority: string | null; planned_min: string;
    }>(
      `SELECT t.id, t.title, t.project_id, p.name AS project_name, t.deadline_at, t.estimate_hours, t.priority,
              COALESCE((SELECT SUM(EXTRACT(EPOCH FROM (b.ends_at - b.starts_at)) / 60)
                          FROM calendar_blocks b
                         WHERE b.tenant_id = t.tenant_id AND b.user_id = $2 AND b.task_id = t.id AND b.ends_at > now()), 0) AS planned_min
         FROM tasks t
         JOIN projects p ON p.id = t.project_id AND p.status <> 'archived'
        WHERE t.tenant_id = $1 AND t.deleted_at IS NULL AND t.closed_at IS NULL
          AND t.assignee_id = $2
        ORDER BY t.deadline_at ASC NULLS LAST, t.id DESC
        LIMIT 100`,
      [tenantId, userId],
    );
  }

  /** Своя занятость для подбора окон: встречи (кроме отказанных и «весь день»), чужие календари, блоки. */
  busyOfMe(tenantId: string, userId: string, from: string, to: string, exceptBlockId?: string) {
    return this.db.many<{ starts_at: Date; ends_at: Date }>(
      `SELECT e.starts_at, e.ends_at
         FROM calendar_events e
         LEFT JOIN calendar_participants p ON p.event_id = e.id AND p.user_id = $2
        WHERE e.tenant_id = $1 AND NOT e.all_day
          AND e.starts_at < $4::timestamptz AND e.ends_at > $3::timestamptz
          AND (e.owner_id = $2 OR (p.user_id IS NOT NULL AND p.status <> 'declined'))
       UNION ALL
       SELECT x.starts_at, x.ends_at
         FROM calendar_external_events x
         JOIN calendar_links l ON l.id = x.link_id
        WHERE x.tenant_id = $1 AND l.user_id = $2 AND l.kind IN ('import', 'google') AND NOT x.all_day
          AND x.starts_at < $4::timestamptz AND x.ends_at > $3::timestamptz
       UNION ALL
       SELECT b.starts_at, b.ends_at
         FROM calendar_blocks b
        WHERE b.tenant_id = $1 AND b.user_id = $2
          AND b.starts_at < $4::timestamptz AND b.ends_at > $3::timestamptz
          AND ($5::bigint IS NULL OR b.id <> $5::bigint)`,
      [tenantId, userId, from, to, exceptBlockId ?? null],
    );
  }

  /** Встречи, с которыми блок пересекается, — подсветка конфликта (п. 19), без запрета. */
  meetingsOverlapping(tenantId: string, userId: string, from: string, to: string) {
    return this.db.many<{ title: string; starts_at: Date; ends_at: Date }>(
      `SELECT e.title, e.starts_at, e.ends_at
         FROM calendar_events e
         LEFT JOIN calendar_participants p ON p.event_id = e.id AND p.user_id = $2
        WHERE e.tenant_id = $1 AND NOT e.all_day
          AND e.starts_at < $4::timestamptz AND e.ends_at > $3::timestamptz
          AND (e.owner_id = $2 OR (p.user_id IS NOT NULL AND p.status <> 'declined'))
        ORDER BY e.starts_at LIMIT 5`,
      [tenantId, userId, from, to],
    );
  }

  async timezoneOf(tenantId: string, userId: string): Promise<string> {
    const row = await this.db.one<{ tz: string | null }>(
      `SELECT COALESCE(u.timezone, t.timezone) AS tz FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1 AND u.tenant_id = $2`,
      [userId, tenantId],
    );
    return row?.tz || 'Europe/Moscow';
  }
}
