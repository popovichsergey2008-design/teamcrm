import { Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'crypto';
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
  /** Договорённость в чате, из которой событие выросло (ТЗ-12, этап 6). */
  source_chat_id?: string | null;
  source_chat_message_id?: string | null;
  /** Созвон у встречи (ТЗ-14): есть постоянная ссылка и комната. */
  is_call?: boolean;
  /** Ссылка встречи — из meet_guest_links вида 'meeting'. */
  public_id?: string | null;
  access_policy?: string | null;
  early_join_min?: number | null;
  guests_allowed?: boolean | null;
}

/** Настройки входа во встречу — живут на её ссылке. Не указано — не трогаем. */
export interface MeetingSettings {
  accessPolicy?: 'trusted' | 'waiting_room' | 'host_required';
  earlyJoinMin?: number;
  guestsAllowed?: boolean;
}

const B62 = '0123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
/** Короткий и не по порядку: перебором соседний не угадать (ТЗ-14, §105). */
export function newPublicId(len = 10): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += B62[bytes[i] % B62.length];
  return out;
}

export interface ParticipantRow {
  event_id: string;
  user_id: string;
  status: 'invited' | 'accepted' | 'declined';
  is_organizer: boolean;
  is_co_organizer?: boolean;
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
      `SELECT e.*, p.status AS my_status, ml.public_id, ml.access_policy, ml.early_join_min, ml.guests_allowed
         FROM calendar_events e
         LEFT JOIN calendar_participants p ON p.event_id = e.id AND p.user_id = $2
         LEFT JOIN meet_guest_links ml ON ml.event_id = e.id AND ml.kind = 'meeting' AND ml.revoked_at IS NULL
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
      `SELECT p.event_id, p.user_id, p.status, p.is_organizer, p.is_co_organizer, u.full_name, u.avatar_file_id
         FROM calendar_participants p
         LEFT JOIN users u ON u.id = p.user_id
        WHERE p.tenant_id = $1 AND p.event_id = ANY($2::bigint[])
        ORDER BY p.is_organizer DESC, u.full_name`,
      [tenantId, eventIds],
    );
  }

  byId(tenantId: string, id: string) {
    return this.db.one<EventRow>(
      `SELECT e.*, ml.public_id, ml.access_policy, ml.early_join_min, ml.guests_allowed
         FROM calendar_events e
         LEFT JOIN meet_guest_links ml ON ml.event_id = e.id AND ml.kind = 'meeting' AND ml.revoked_at IS NULL
        WHERE e.tenant_id = $1 AND e.id = $2`,
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
    isCall: boolean; meeting?: MeetingSettings; coOrganizerIds?: string[];
  }): Promise<EventRow> {
    return this.db.withTransaction(async (c) => {
      const { rows } = await c.query<EventRow>(
        `INSERT INTO calendar_events
           (tenant_id, scope, owner_id, title, description, location, meet_room_id,
            starts_at, ends_at, all_day, color, is_private, created_by, is_call)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [input.tenantId, input.scope, input.ownerId, input.title, input.description, input.location,
          input.meetRoomId, input.startsAt, input.endsAt, input.allDay, input.color, input.isPrivate,
          input.createdBy, input.isCall],
      );
      const event = rows[0];
      await this.writeParticipants(c, input.tenantId, event.id, input.ownerId, input.participantIds, input.coOrganizerIds);
      await this.syncMeeting(c, input.tenantId, String(event.id), input.meeting);
      return event;
    });
  }

  /**
   * Ссылка встречи — в лад с событием (ТЗ-14).
   *
   * Созвон включён: у события есть комната, у комнаты — постоянная ссылка с public_id,
   * время и название ссылки — как у события. Выключен — ссылка отозвана (её адрес
   * покажет, что созвона у встречи больше нет). Ссылка НЕ меняется при переносе: public_id
   * выдаётся один раз и потом только переживает правки.
   */
  async syncMeeting(c: { query: (sql: string, params: unknown[]) => Promise<{ rows: any[] }> },
    tenantId: string, eventId: string, settings: MeetingSettings = {}): Promise<void> {
    const ev = (await c.query(
      `SELECT id, is_call, all_day, meet_room_id, title, starts_at, ends_at, owner_id
         FROM calendar_events WHERE tenant_id=$1 AND id=$2`, [tenantId, eventId],
    )).rows[0];
    if (!ev) return;
    if (!ev.is_call) {
      await c.query(
        `UPDATE meet_guest_links SET revoked_at = COALESCE(revoked_at, now())
          WHERE tenant_id=$1 AND event_id=$2 AND kind='meeting'`, [tenantId, eventId],
      );
      return;
    }
    const room = (await c.query(
      `UPDATE calendar_events SET meet_room_id = COALESCE(meet_room_id, $3)
        WHERE tenant_id=$1 AND id=$2 RETURNING meet_room_id`, [tenantId, eventId, randomUUID()],
    )).rows[0].meet_room_id as string;
    await c.query(
      `INSERT INTO meet_guest_links
         (tenant_id, room_id, label, token_hash, created_by, expires_at, starts_at, ends_at, event_id, kind,
          public_id, access_policy, early_join_min, guests_allowed)
       VALUES ($1, $2, left($3, 120), $4, $5,
               GREATEST($7::timestamptz, $6::timestamptz) + interval '4 hours', $6, $7, $8, 'meeting',
               $9, COALESCE($10, 'trusted'), COALESCE($11, 15), COALESCE($12, TRUE))
       ON CONFLICT (event_id) WHERE kind = 'meeting' DO UPDATE SET
         room_id = EXCLUDED.room_id, label = EXCLUDED.label, created_by = EXCLUDED.created_by,
         ended_at = CASE WHEN meet_guest_links.starts_at IS DISTINCT FROM EXCLUDED.starts_at THEN NULL ELSE meet_guest_links.ended_at END,
         reminded_at = CASE WHEN meet_guest_links.starts_at IS DISTINCT FROM EXCLUDED.starts_at THEN NULL ELSE meet_guest_links.reminded_at END,
         starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at,
         expires_at = GREATEST(meet_guest_links.expires_at, EXCLUDED.expires_at),
         revoked_at = NULL, cancelled_at = NULL,
         access_policy = COALESCE($10, meet_guest_links.access_policy),
         early_join_min = COALESCE($11, meet_guest_links.early_join_min),
         guests_allowed = COALESCE($12, meet_guest_links.guests_allowed)`,
      [tenantId, room, ev.title, `meeting:${randomUUID()}`, ev.owner_id, ev.starts_at, ev.ends_at, eventId,
        newPublicId(), settings.accessPolicy ?? null, settings.earlyJoinMin ?? null, settings.guestsAllowed ?? null],
    );
    // личные ссылки гостей встречи — с тем же ранним входом и концом встречи
    await c.query(
      `UPDATE meet_guest_links g
          SET early_join_min = m.early_join_min, ends_at = $3, label = COALESCE(g.invite_name, g.invite_email, g.label)
         FROM meet_guest_links m
        WHERE m.tenant_id = $1 AND m.event_id = $2 AND m.kind = 'meeting'
          AND g.event_id = $2 AND g.kind = 'guest' AND g.revoked_at IS NULL`,
      [tenantId, eventId, ev.ends_at],
    );
  }

  async update(tenantId: string, id: string, patch: Record<string, unknown>, participantIds?: string[], ownerId?: string,
    meeting?: MeetingSettings, coOrganizerIds?: string[]) {
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
        /*
          Встречу перенесли — гостевые ссылки из неё переезжают следом: иначе гость
          ждал бы по старому времени, а напоминание открыть комнату ушло бы не тогда.
          Срок ссылки только продлевается — укоротить его перенос не должен.
        */
        await c.query(
          `UPDATE meet_guest_links l
              SET starts_at = e.starts_at, reminded_at = NULL, guest_reminded_at = NULL, ends_at = e.ends_at,
                  expires_at = GREATEST(l.expires_at, e.starts_at + interval '4 hours', e.ends_at + interval '1 hour')
             FROM calendar_events e
            WHERE e.tenant_id = $1 AND e.id = $2 AND l.event_id = e.id AND l.revoked_at IS NULL
              AND l.starts_at IS DISTINCT FROM e.starts_at`,
          [tenantId, id],
        );
      }
      if (participantIds && ownerId) {
        // соорганизаторов не передали — сохраняем прежних, а не теряем при правке состава
        const keep = coOrganizerIds ?? (await c.query(
          `SELECT user_id::text FROM calendar_participants WHERE event_id=$1 AND is_co_organizer`, [id],
        )).rows.map((r: { user_id: string }) => r.user_id);
        await c.query(`DELETE FROM calendar_participants WHERE event_id = $1`, [id]);
        await this.writeParticipants(c, tenantId, id, ownerId, participantIds, keep);
      } else if (coOrganizerIds) {
        await c.query(
          `UPDATE calendar_participants SET is_co_organizer = (user_id = ANY($2::bigint[]))
            WHERE event_id=$1 AND NOT is_organizer`, [id, coOrganizerIds],
        );
      }
      await this.syncMeeting(c, tenantId, id, meeting);
      const { rows } = await c.query<EventRow>(`SELECT * FROM calendar_events WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
      return rows[0] ?? null;
    });
  }

  async remove(tenantId: string, id: string): Promise<void> {
    /*
      Ссылки встречи не исчезают вместе с событием: по ним уже могли разослать
      приглашения. Старая ссылка покажет «Встреча отменена», а не «не найдено» (ТЗ-14, §14).
    */
    await this.db.query(
      `UPDATE meet_guest_links SET cancelled_at = now(), revoked_at = COALESCE(revoked_at, now())
        WHERE tenant_id=$1 AND event_id=$2`, [tenantId, id],
    );
    await this.db.query(`DELETE FROM calendar_events WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }

  /** Гости встречи по email с их зашифрованной ссылкой — для писем о переносе и отмене. */
  guestInvites(tenantId: string, eventId: string) {
    return this.db.many<{ id: string; invite_email: string; invite_name: string | null; token_enc: string | null }>(
      `SELECT id::text, invite_email, invite_name, token_enc FROM meet_guest_links
        WHERE tenant_id = $1 AND event_id = $2 AND invite_email IS NOT NULL AND revoked_at IS NULL`,
      [tenantId, eventId],
    );
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
  /**
   * Сроки задач в промежутке.
   *
   * Отдаём приоритет и признак завершения: в календаре срочное, важное и просроченное
   * обязано отличаться цветом, а сделанное — не кричать. Без этих полей все сроки
   * выглядели одинаково серыми, и смотреть на них было бессмысленно.
   */
  tasksInRange(tenantId: string, userId: string, from: string, to: string) {
    return this.db.many<{
      id: string; title: string; deadline_at: Date; project_id: string; status: string;
      priority: string | null; closed_at: Date | null;
    }>(
      `SELECT t.id, t.title, t.deadline_at, t.project_id, t.status, t.priority, t.closed_at
         FROM tasks t
         JOIN projects p ON p.id = t.project_id AND p.status <> 'archived'
        WHERE t.tenant_id = $1 AND t.deleted_at IS NULL AND t.deadline_at IS NOT NULL
          AND t.deadline_at >= $3::timestamptz AND t.deadline_at < $4::timestamptz
          AND (t.assignee_id = $2 OR t.created_by = $2)
        ORDER BY t.deadline_at`,
      [tenantId, userId, from, to],
    );
  }

  /**
   * Занятость людей в промежутке: события и отпуска, без названий.
   *
   * Именно интервалы, а не события: коллеге при выборе времени нужно знать, что человек
   * занят, а не чем именно. Отказавшиеся от встречи свободны — они на неё не идут.
   */
  busyOf(tenantId: string, userIds: string[], from: string, to: string, exceptEventId?: string) {
    if (!userIds.length) return Promise.resolve([] as { user_id: string; starts_at: Date; ends_at: Date; kind: string }[]);
    return this.db.many<{ user_id: string; starts_at: Date; ends_at: Date; kind: string }>(
      // Событие «весь день» помечаем отдельно: это заметка на сутки (поездка, дежурство),
      // а не занятое время. Считать его занятостью значит запретить на этот день любые встречи.
      `SELECT p.user_id, e.starts_at, e.ends_at,
              CASE WHEN e.all_day THEN 'all_day' ELSE 'event' END AS kind
         FROM calendar_participants p
         JOIN calendar_events e ON e.id = p.event_id
        WHERE p.tenant_id = $1 AND p.user_id = ANY($2::bigint[]) AND p.status <> 'declined'
          AND e.starts_at < $4::timestamptz AND e.ends_at > $3::timestamptz
          AND ($5::bigint IS NULL OR e.id <> $5::bigint)
       UNION ALL
       -- отпуск и больничный — это тоже «занят», просто на целые дни
       SELECT a.user_id, a.from_date::timestamptz, (a.to_date + 1)::timestamptz, a.kind
         FROM user_availability a
        WHERE a.tenant_id = $1 AND a.user_id = ANY($2::bigint[])
          AND a.from_date::timestamptz < $4::timestamptz AND (a.to_date + 1)::timestamptz > $3::timestamptz
        ORDER BY 2`,
      [tenantId, userIds, from, to, exceptEventId ?? null],
    );
  }

  /**
   * Кто из этих людей занят в это время И запретил ставить себе встречи внахлёст.
   *
   * Проверяем только тех, кто сам включил запрет: чужой календарь — не наше дело,
   * пока человек не попросил его беречь.
   */
  conflictsFor(tenantId: string, userIds: string[], startsAt: string, endsAt: string, exceptEventId?: string) {
    if (!userIds.length) return Promise.resolve([] as { user_id: string; full_name: string; starts_at: Date; ends_at: Date; title: string }[]);
    return this.db.many<{ user_id: string; full_name: string; starts_at: Date; ends_at: Date; title: string }>(
      `SELECT p.user_id, u.full_name, e.starts_at, e.ends_at, e.title
         FROM calendar_participants p
         JOIN calendar_events e ON e.id = p.event_id
         JOIN users u ON u.id = p.user_id
        WHERE p.tenant_id = $1 AND p.user_id = ANY($2::bigint[]) AND p.status <> 'declined'
          AND u.calendar_block_overlap AND u.is_active
          -- «весь день» не запрещает встречи: это пометка на сутки, а не занятое время
          AND NOT e.all_day
          AND e.starts_at < $4::timestamptz AND e.ends_at > $3::timestamptz
          AND ($5::bigint IS NULL OR e.id <> $5::bigint)
        ORDER BY u.full_name`,
      [tenantId, userIds, startsAt, endsAt, exceptEventId ?? null],
    );
  }

  /** Напоминания события: «за 15 минут», «за день». Хранятся минутами до начала. */
  async remindersOf(eventIds: string[]): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    if (!eventIds.length) return out;
    const rows = await this.db.many<{ event_id: string; minutes_before: number }>(
      `SELECT event_id, minutes_before FROM calendar_reminders
        WHERE event_id = ANY($1::bigint[]) ORDER BY minutes_before`,
      [eventIds],
    );
    for (const r of rows) {
      const list = out.get(String(r.event_id)) ?? [];
      list.push(Number(r.minutes_before));
      out.set(String(r.event_id), list);
    }
    return out;
  }

  async setReminders(eventId: string, minutes: number[]): Promise<void> {
    await this.db.withTransaction(async (c) => {
      await c.query(`DELETE FROM calendar_reminders WHERE event_id = $1`, [eventId]);
      for (const m of new Set(minutes)) {
        await c.query(
          `INSERT INTO calendar_reminders (event_id, minutes_before) VALUES ($1,$2)
           ON CONFLICT DO NOTHING`,
          [eventId, m],
        );
      }
    });
  }

  /**
   * Напоминания, которым пора уйти.
   *
   * Берём окно «уже пора, но не раньше чем полчаса назад»: если сервис лежал, устаревшее
   * напоминание о встрече, которая давно идёт, человеку не нужно — оно только сбивает.
   * Отказавшихся не тревожим, отправленное отсеиваем по журналу.
   */
  dueReminders(windowMinutes = 30) {
    return this.db.many<{
      event_id: string; tenant_id: string; user_id: string; minutes_before: number;
      title: string; starts_at: Date; ends_at: Date; location: string | null; all_day: boolean;
      email: string; full_name: string; owner_id: string; public_id: string | null;
    }>(
      `SELECT e.id AS event_id, e.tenant_id, p.user_id, r.minutes_before,
              e.title, e.starts_at, e.ends_at, e.location, e.all_day, e.owner_id,
              u.email, u.full_name,
              CASE WHEN e.is_call THEN ml.public_id END AS public_id
         FROM calendar_reminders r
         JOIN calendar_events e ON e.id = r.event_id
         LEFT JOIN meet_guest_links ml ON ml.event_id = e.id AND ml.kind = 'meeting' AND ml.revoked_at IS NULL
         JOIN calendar_participants p ON p.event_id = e.id AND p.status <> 'declined'
         JOIN users u ON u.id = p.user_id AND u.is_active
        WHERE e.starts_at - make_interval(mins => r.minutes_before) <= now()
          AND e.starts_at > now() - make_interval(mins => $1::int)
          AND NOT EXISTS (
            SELECT 1 FROM calendar_reminder_log l
             WHERE l.event_id = e.id AND l.user_id = p.user_id
               AND l.minutes_before = r.minutes_before AND l.starts_at = e.starts_at)
        LIMIT 200`,
      [windowMinutes],
    );
  }

  async markReminderSent(eventId: string, userId: string, minutes: number, startsAt: Date): Promise<void> {
    await this.db.query(
      `INSERT INTO calendar_reminder_log (event_id, user_id, minutes_before, starts_at)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [eventId, userId, minutes, startsAt],
    );
  }

  /** Почты участников — для приглашения с .ics. */
  participantContacts(tenantId: string, eventId: string) {
    return this.db.many<{ user_id: string; email: string; full_name: string; is_organizer: boolean; status: string }>(
      `SELECT p.user_id, u.email, u.full_name, p.is_organizer, p.status
         FROM calendar_participants p JOIN users u ON u.id = p.user_id
        WHERE p.tenant_id = $1 AND p.event_id = $2 AND u.is_active`,
      [tenantId, eventId],
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
    tenantId: string, eventId: string, ownerId: string, participantIds: string[], coOrganizerIds: string[] = []) {
    const co = new Set(coOrganizerIds.map(String));
    const unique = new Set(participantIds.map(String));
    unique.delete(String(ownerId));
    await c.query(
      `INSERT INTO calendar_participants (event_id, tenant_id, user_id, status, is_organizer, responded_at)
       VALUES ($1,$2,$3,'accepted',TRUE, now())`,
      [eventId, tenantId, ownerId],
    );
    for (const uid of unique) {
      await c.query(
        `INSERT INTO calendar_participants (event_id, tenant_id, user_id, status, is_organizer, is_co_organizer)
         SELECT $1,$2,$3,'invited',FALSE,$4
          WHERE EXISTS (SELECT 1 FROM users WHERE tenant_id = $2 AND id = $3 AND is_active)`,
        [eventId, tenantId, uid, co.has(uid)],
      );
    }
  }
}
