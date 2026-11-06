import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { DbService } from '../../database/db.service';
import { CalendarService } from './calendar.service';

type Viewer = { userId: string; role: string };

/**
 * Карточка встречи до и после созвона (#4787, п. 10–11).
 *
 * До: цель («какой результат хотим получить»), связанные задачи. После: итог, решения,
 * кто что должен и к какому сроку — из разбора созвона этой встречи — и ссылки на
 * созданные задачи. Через неделю человек открывает событие и понимает, чем закончилось.
 * Право видеть карточку — то же, что право видеть само событие.
 */
@Injectable()
export class CalendarCardService {
  constructor(private readonly db: DbService, private readonly calendar: CalendarService) {}

  async card(tenantId: string, user: Viewer, eventId: string) {
    const ev = await this.calendar.details(tenantId, user, eventId) as { meetRoomId?: string | null };
    const goal = await this.db.one<{ goal: string | null }>(`SELECT goal FROM calendar_events WHERE tenant_id = $1 AND id = $2`, [tenantId, eventId]);
    const boss = user.role === 'owner' || user.role === 'manager';
    const tasks = await this.db.many<any>(
      `SELECT t.id::text, t.title, t.status, t.closed_at, t.deadline_at, t.project_id::text AS project_id, u.full_name AS assignee, l.source
         FROM calendar_event_tasks l
         JOIN tasks t ON t.id = l.task_id AND t.deleted_at IS NULL
         JOIN projects p ON p.id = t.project_id
         LEFT JOIN users u ON u.id = t.assignee_id
        WHERE l.tenant_id = $1 AND l.event_id = $2
          AND ($4::boolean OR p.visibility = 'all' OR p.owner_user_id = $3::bigint OR t.assignee_id = $3::bigint OR t.created_by = $3::bigint
               OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $3::bigint))
        ORDER BY l.created_at`,
      [tenantId, eventId, user.userId, boss],
    );
    const meeting = await this.db.one<any>(
      `SELECT m.id::text, m.status, s.summary, s.decisions
         FROM meetings m
         LEFT JOIN meeting_summaries s ON s.meeting_id = m.id
        WHERE m.tenant_id = $1 AND (m.event_id = $2 OR ($3::text IS NOT NULL AND m.room_id = $3::text))
        ORDER BY m.created_at DESC LIMIT 1`,
      [tenantId, eventId, ev.meetRoomId ?? null],
    );
    const drafts = meeting ? await this.db.many<any>(
      `SELECT d.id::text, d.title, d.deadline_at, d.status, d.task_id::text AS task_id, t.project_id::text AS project_id,
              COALESCE(u.full_name, d.assignee_hint) AS assignee
         FROM meeting_task_drafts d
         LEFT JOIN users u ON u.id = d.assignee_id
         LEFT JOIN tasks t ON t.id = d.task_id
        WHERE d.tenant_id = $1 AND d.meeting_id = $2 AND d.status <> 'rejected'
        ORDER BY d.id`,
      [tenantId, meeting.id],
    ) : [];
    const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
    return {
      goal: goal?.goal ?? null,
      tasks: tasks.map((t) => ({
        id: t.id, title: t.title, projectId: t.project_id, assignee: t.assignee, deadlineAt: iso(t.deadline_at),
        done: !!t.closed_at || t.status === 'DONE', source: t.source as 'linked' | 'meeting',
      })),
      after: meeting ? {
        meetingId: meeting.id, status: meeting.status as string,
        summary: (meeting.summary as string | null) ?? null,
        decisions: (Array.isArray(meeting.decisions) ? meeting.decisions : []).map((x: unknown) => (typeof x === 'string' ? x : (x as { text?: string })?.text ?? '')).filter(Boolean),
        assignments: drafts.map((d) => ({
          title: d.title, assignee: d.assignee, deadlineAt: iso(d.deadline_at), status: d.status as string,
          taskId: d.task_id, projectId: d.project_id,
        })),
      } : null,
    };
  }

  async setGoal(tenantId: string, user: Viewer, eventId: string, goal: string | null) {
    const ev = await this.calendar.details(tenantId, user, eventId) as { canEdit?: boolean };
    if (!ev.canEdit) throw AppException.forbidden('Цель встречи меняет организатор');
    await this.db.query(`UPDATE calendar_events SET goal = $3 WHERE tenant_id = $1 AND id = $2`, [tenantId, eventId, goal?.trim().slice(0, 500) || null]);
    return this.card(tenantId, user, eventId);
  }

  /** Связать задачу со встречей («какие задачи связаны со встречей»). Видеть надо и то и другое. */
  async link(tenantId: string, user: Viewer, eventId: string, taskId: string) {
    await this.calendar.details(tenantId, user, eventId);
    const boss = user.role === 'owner' || user.role === 'manager';
    const ok = await this.db.one<{ ok: boolean }>(
      `SELECT TRUE AS ok FROM tasks t JOIN projects p ON p.id = t.project_id
        WHERE t.tenant_id = $1 AND t.id = $2 AND t.deleted_at IS NULL
          AND ($4::boolean OR p.visibility = 'all' OR p.owner_user_id = $3::bigint OR t.assignee_id = $3::bigint OR t.created_by = $3::bigint
               OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $3::bigint))`,
      [tenantId, taskId, user.userId, boss],
    );
    if (!ok) throw AppException.notFound('Задача не найдена');
    await this.db.query(
      `INSERT INTO calendar_event_tasks (tenant_id, event_id, task_id, source, created_by) VALUES ($1, $2, $3, 'linked', $4)
       ON CONFLICT (event_id, task_id) DO NOTHING`,
      [tenantId, eventId, taskId, user.userId],
    );
    return this.card(tenantId, user, eventId);
  }

  async unlink(tenantId: string, user: Viewer, eventId: string, taskId: string) {
    await this.calendar.details(tenantId, user, eventId);
    await this.db.query(`DELETE FROM calendar_event_tasks WHERE tenant_id = $1 AND event_id = $2 AND task_id = $3 AND source = 'linked'`, [tenantId, eventId, taskId]);
    return this.card(tenantId, user, eventId);
  }

  /**
   * Задачи, созданные из итогов встречи, — к её событию (п. 11): «задачи связаны со
   * встречей». Повтор ничего не дублирует. Зовёт пакет задач разбора созвона.
   */
  async linkFromMeeting(tenantId: string, meetingId: string, taskIds: string[], actorId: string) {
    if (!taskIds.length) return;
    await this.db.query(
      `INSERT INTO calendar_event_tasks (tenant_id, event_id, task_id, source, created_by)
       SELECT $1, ev.id, t.id, 'meeting', $4
         FROM meetings m
         JOIN LATERAL (
           SELECT e.id FROM calendar_events e
            WHERE e.tenant_id = m.tenant_id AND (e.id = m.event_id OR (m.room_id IS NOT NULL AND e.meet_room_id = m.room_id))
            ORDER BY (e.id = m.event_id) DESC, abs(EXTRACT(EPOCH FROM (e.starts_at - COALESCE(m.happened_at, m.created_at)))) LIMIT 1
         ) ev ON TRUE
         JOIN tasks t ON t.tenant_id = m.tenant_id AND t.id = ANY($3::bigint[])
        WHERE m.tenant_id = $1 AND m.id = $2
       ON CONFLICT (event_id, task_id) DO NOTHING`,
      [tenantId, meetingId, taskIds, actorId],
    );
  }
}
