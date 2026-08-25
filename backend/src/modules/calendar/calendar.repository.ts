import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface EventRow {
  id: string;
  tenant_id: string;
  scope: 'personal' | 'company';
  owner_id: string;
  title: string;
  description: string | null;
  location: string | null;
  meet_room_id: string | null;
  starts_at: Date;
  ends_at: Date;
  all_day: boolean;
  color: string | null;
  is_private: boolean;
  created_by: string;
}

export interface ParticipantRow {
  event_id: string;
  user_id: string;
  status: 'invited' | 'accepted' | 'declined';
  is_organizer: boolean;
  full_name: string | null;
  avatar_file_id: string | null;
}

export interface WorkSettingsRow {
  work_start: string;
  work_end: string;
  weekend_days: number[];
  holidays: (Date | string)[];
}

@Injectable()
export class CalendarRepository {
  constructor(private readonly db: DbService) {}

  /**
   * События, попадающие в промежуток.
   *
   * Условие пересечения именно такое: событие видно, если оно НАЧАЛОСЬ до конца окна
   * и ЗАКОНЧИЛОСЬ после его начала. Наивное `starts_at BETWEEN` теряло бы встречу,
   * которая началась вчера и идёт до сегодня, — а это как раз то, что важно видеть.
   */
  eventsInRange(tenantId: string, userId: string, from: string, to: string) {
    return this.db.many<EventRow & { my_status: string | null }>(
      `SELECT e.*, p.status AS my_status
         FROM calendar_events e
         LEFT JOIN calendar_participants p ON p.event_id = e.id AND p.user_id = $2
        WHERE e.tenant_id = $1
          AND e.starts_at < $4::timestamptz
          AND e.ends_at   > $3::timestamptz
          AND (e.scope = 'company' OR e.owner_id = $2 OR p.user_id IS NOT NULL)
        ORDER BY e.starts_at`,
      [tenantId, userId, from, to],
    );
  }

  participantsFor(tenantId: string, eventIds: string[]) {
    if (!eventIds.length) return Promise.resolve([] as ParticipantRow[]);
    return this.db.many<ParticipantRow>(
      `SELECT p.event_id, p.user_id, p.status, p.is_organizer, u.full_name, u.avatar_file_id
         FROM calendar_participants p
         LEFT JOIN users u ON u.id = p.user_id
        WHERE p.tenant_id = $1 AND p.event_id = ANY($2::bigint[])
        ORDER BY p.is_organizer DESC, u.full_name`,
      [tenantId, eventIds],
    );
  }

  byId(tenantId: string, id: string) {
    return this.db.one<EventRow>(
      `SELECT * FROM calendar_events WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
  }

  /** Сколько приглашений ждут ответа — счётчик у пункта меню. */
  async pendingCount(tenantId: string, userId: string): Promise<number> {
    const row = await this.db.one<{ n: string }>(
      `SELECT count(*) AS n
         FROM calendar_participants p JOIN calendar_events e ON e.id = p.event_id
        WHERE p.tenant_id = $1 AND p.user_id = $2 AND p.status = 'invited'
          AND e.ends_at > now()`,
      [tenantId, userId],
    );
    return Number(row?.n ?? 0);
  }

  /** Создание события и его участников — одной транзакцией: событие без организатора бессмысленно. */
  async create(input: {
    tenantId: string; scope: string; ownerId: string; title: string; description: string | null;
    location: string | null; meetRoomId: string | null; startsAt: string; endsAt: string;
    allDay: boolean; color: string | null; isPrivate: boolean; createdBy: string; participantIds: string[];
  }): Promise<EventRow> {
    return this.db.withTransaction(async (c) => {
      const { rows } = await c.query<EventRow>(
        `INSERT INTO calendar_events
           (tenant_id, scope, owner_id, title, description, location, meet_room_id,
            starts_at, ends_at, all_day, color, is_private, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [input.tenantId, input.scope, input.ownerId, input.title, input.description, input.location,
          input.meetRoomId, input.startsAt, input.endsAt, input.allDay, input.color, input.isPrivate,
          input.createdBy],
      );
      const event = rows[0];
      await this.writeParticipants(c, input.tenantId, event.id, input.ownerId, input.participantIds);
      return event;
    });
  }

  async update(tenantId: string, id: string, patch: Record<string, unknown>, participantIds?: string[], ownerId?: string) {
    return this.db.withTransaction(async (c) => {
      const sets: string[] = [];
      const vals: unknown[] = [];
      let i = 1;
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        sets.push(`${k} = $${i++}`);
        vals.push(v);
      }
      if (sets.length) {
        sets.push('updated_at = now()');
        vals.push(tenantId, id);
        await c.query(`UPDATE calendar_events SET ${sets.join(', ')} WHERE tenant_id=$${i++} AND id=$${i}`, vals);
      }
      if (participantIds && ownerId) {
        await c.query(`DELETE FROM calendar_participants WHERE event_id = $1`, [id]);
        await this.writeParticipants(c, tenantId, id, ownerId, participantIds);
      }
      const { rows } = await c.query<EventRow>(`SELECT * FROM calendar_events WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
      return rows[0] ?? null;
    });
  }

  async remove(tenantId: string, id: string): Promise<void> {
    await this.db.query(`DELETE FROM calendar_events WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }

  /** Ответ на приглашение меняет ровно свою строку — чужие ответы не трогаем. */
  async respond(tenantId: string, eventId: string, userId: string, status: 'accepted' | 'declined'): Promise<boolean> {
    const res = await this.db.query(
      `UPDATE calendar_participants SET status = $4, responded_at = now()
        WHERE tenant_id = $1 AND event_id = $2 AND user_id = $3`,
      [tenantId, eventId, userId, status],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Задачи со сроком в окне — отдельный слой поверх событий, как в привычных календарях. */
  tasksInRange(tenantId: string, userId: string, from: string, to: string) {
    return this.db.many<{ id: string; title: string; deadline_at: Date; project_id: string; status: string }>(
      `SELECT t.id, t.title, t.deadline_at, t.project_id, t.status
         FROM tasks t
        WHERE t.tenant_id = $1 AND t.deadline_at IS NOT NULL
          AND t.deadline_at >= $3::timestamptz AND t.deadline_at < $4::timestamptz
          AND (t.assignee_id = $2 OR t.created_by = $2)
        ORDER BY t.deadline_at`,
      [tenantId, userId, from, to],
    );
  }

  async workSettings(tenantId: string): Promise<WorkSettingsRow | null> {
    return this.db.one<WorkSettingsRow>(
      // holidays приводим к тексту прямо в запросе: как DATE[] драйвер отдаёт JS-даты в
      // локальном поясе процесса, и «1 января» на сервере с поясом +3 превращалось бы
      // в «31 декабря» — праздник тихо съезжал бы на день
      `SELECT work_start::text, work_end::text, weekend_days, holidays::text[] AS holidays
         FROM org_work_settings WHERE tenant_id = $1`,
      [tenantId],
    );
  }

  async saveWorkSettings(tenantId: string, actorId: string, s: {
    workStart: string; workEnd: string; weekendDays: number[]; holidays: string[];
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO org_work_settings (tenant_id, work_start, work_end, weekend_days, holidays, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (tenant_id) DO UPDATE
          SET work_start = EXCLUDED.work_start, work_end = EXCLUDED.work_end,
              weekend_days = EXCLUDED.weekend_days, holidays = EXCLUDED.holidays,
              updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [tenantId, s.workStart, s.workEnd, s.weekendDays, s.holidays, actorId],
    );
  }

  /** Организатор всегда участник и всегда «принял»: он событие и создал. */
  private async writeParticipants(c: { query: (sql: string, params: unknown[]) => Promise<unknown> },
    tenantId: string, eventId: string, ownerId: string, participantIds: string[]) {
    const unique = new Set(participantIds.map(String));
    unique.delete(String(ownerId));
    await c.query(
      `INSERT INTO calendar_participants (event_id, tenant_id, user_id, status, is_organizer, responded_at)
       VALUES ($1,$2,$3,'accepted',TRUE, now())`,
      [eventId, tenantId, ownerId],
    );
    for (const uid of unique) {
      await c.query(
        `INSERT INTO calendar_participants (event_id, tenant_id, user_id, status, is_organizer)
         SELECT $1,$2,$3,'invited',FALSE
          WHERE EXISTS (SELECT 1 FROM users WHERE tenant_id = $2 AND id = $3 AND is_active)`,
        [eventId, tenantId, uid],
      );
    }
  }
}
