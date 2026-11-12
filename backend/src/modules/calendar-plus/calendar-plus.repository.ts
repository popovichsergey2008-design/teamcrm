import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface PrefsRow {
  user_id: string; tenant_id: string;
  work_start: string | null; work_end: string | null; lunch_start: string | null; lunch_end: string | null;
  focus_goal_min: number; dismissed: string[]; chat_suggest: boolean; prep_min: number; onboarded_at: Date | null;
}

export interface MyMeetingRow {
  id: string; title: string; description: string | null; starts_at: Date; ends_at: Date; all_day: boolean;
  owner_id: string; participants: number; has_agenda: boolean; my_status: string | null; public_id: string | null;
  meet_room_id: string | null; series_id: string | null;
}

export interface ProposalRow {
  id: string; tenant_id: string; chat_id: string; message_id: string | null; source_message_id: string | null; author_id: string;
  topic: string | null; minutes: number; member_ids: string[];
  slots: { startsAt: string; endsAt: string; reasons?: string[] }[];
  votes: Record<string, string[]>; status: 'open' | 'scheduled' | 'cancelled'; event_id: string | null; created_at: Date;
}

/** Данные для календаря #4892: свои настройки, занятость людей без чужих подробностей, предложения в чате. */
@Injectable()
export class CalendarPlusRepository {
  constructor(private readonly db: DbService) {}

  prefs(tenantId: string, userId: string) {
    return this.db.one<PrefsRow>(`SELECT * FROM calendar_user_prefs WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]);
  }

  prefsOf(tenantId: string, userIds: string[]) {
    return this.db.many<PrefsRow>(`SELECT * FROM calendar_user_prefs WHERE tenant_id = $1 AND user_id = ANY($2::bigint[])`, [tenantId, userIds]);
  }

  async savePrefs(tenantId: string, userId: string, p: Partial<{
    work_start: string | null; work_end: string | null; lunch_start: string | null; lunch_end: string | null;
    focus_goal_min: number; chat_suggest: boolean; prep_min: number; onboarded: boolean;
  }>) {
    await this.db.query(
      `INSERT INTO calendar_user_prefs (user_id, tenant_id) VALUES ($2, $1) ON CONFLICT (user_id) DO NOTHING`, [tenantId, userId]);
    const sets: string[] = [];
    const args: unknown[] = [tenantId, userId];
    const put = (col: string, v: unknown) => { args.push(v); sets.push(`${col} = $${args.length}`); };
    for (const k of ['work_start', 'work_end', 'lunch_start', 'lunch_end', 'focus_goal_min', 'chat_suggest', 'prep_min'] as const) {
      if (p[k] !== undefined) put(k, p[k]);
    }
    if (p.onboarded) sets.push('onboarded_at = COALESCE(onboarded_at, now())');
    if (sets.length) {
      await this.db.query(`UPDATE calendar_user_prefs SET ${sets.join(', ')}, updated_at = now() WHERE tenant_id = $1 AND user_id = $2`, args);
    }
    return this.prefs(tenantId, userId);
  }

  async dismiss(tenantId: string, userId: string, key: string) {
    await this.db.query(
      `INSERT INTO calendar_user_prefs (user_id, tenant_id, dismissed) VALUES ($2, $1, ARRAY[$3::text])
       ON CONFLICT (user_id) DO UPDATE SET dismissed = (
         SELECT array_agg(DISTINCT x) FROM unnest(calendar_user_prefs.dismissed || ARRAY[$3::text]) x), updated_at = now()`,
      [tenantId, userId, key.slice(0, 120)],
    );
  }

  people(tenantId: string, ids: string[]) {
    return this.db.many<{ id: string; full_name: string; tz: string }>(
      `SELECT u.id::text, u.full_name, COALESCE(u.timezone, t.timezone, 'Europe/Moscow') AS tz
         FROM users u JOIN tenants t ON t.id = u.tenant_id
        WHERE u.tenant_id = $1 AND u.id = ANY($2::bigint[]) AND u.is_active`,
      [tenantId, ids],
    );
  }

  /** Встречи, где человек организатор или идёт (не отказался), — со своими названиями. */
  myMeetings(tenantId: string, userId: string, from: string, to: string) {
    return this.db.many<MyMeetingRow>(
      `SELECT e.id::text, e.title, e.description, e.starts_at, e.ends_at, e.all_day, e.owner_id::text,
              CASE WHEN e.is_call THEN ml.public_id END AS public_id, e.meet_room_id, e.series_id::text AS series_id,
              (SELECT count(*)::int FROM calendar_participants pp WHERE pp.event_id = e.id AND pp.status <> 'declined') AS participants,
              (COALESCE(btrim(e.description), '') <> '' OR EXISTS (SELECT 1 FROM meeting_agendas a WHERE a.event_id = e.id)) AS has_agenda,
              p.status AS my_status
         FROM calendar_events e
         LEFT JOIN calendar_participants p ON p.event_id = e.id AND p.user_id = $2
         LEFT JOIN meet_guest_links ml ON ml.event_id = e.id AND ml.kind = 'meeting' AND ml.revoked_at IS NULL
        WHERE e.tenant_id = $1 AND NOT e.all_day
          AND e.starts_at < $4::timestamptz AND e.ends_at > $3::timestamptz
          AND (e.owner_id = $2 OR (p.user_id IS NOT NULL AND p.status <> 'declined'))
        ORDER BY e.starts_at`,
      [tenantId, userId, from, to],
    );
  }

  /**
   * Занятость людей для подбора: встречи (без названий), фокус, внешние календари,
   * отпуск. Название — только у встреч самого ищущего: «сразу после планёрки».
   */
  busyOfPeople(tenantId: string, userIds: string[], meId: string, from: string, to: string, exceptEventId?: string | null) {
    return this.db.many<{ user_id: string; starts_at: Date; ends_at: Date; kind: 'meeting' | 'focus' | 'away'; title: string | null }>(
      `SELECT p.user_id::text, e.starts_at, e.ends_at, 'meeting' AS kind,
              CASE WHEN p.user_id = $3::bigint THEN e.title END AS title
         FROM calendar_participants p JOIN calendar_events e ON e.id = p.event_id
        WHERE p.tenant_id = $1 AND p.user_id = ANY($2::bigint[]) AND p.status <> 'declined' AND NOT e.all_day
          AND e.starts_at < $5::timestamptz AND e.ends_at > $4::timestamptz AND ($6::bigint IS NULL OR e.id <> $6::bigint)
       UNION ALL
       SELECT e.owner_id::text, e.starts_at, e.ends_at, 'meeting', CASE WHEN e.owner_id = $3::bigint THEN e.title END
         FROM calendar_events e
        WHERE e.tenant_id = $1 AND e.owner_id = ANY($2::bigint[]) AND NOT e.all_day
          AND NOT EXISTS (SELECT 1 FROM calendar_participants p WHERE p.event_id = e.id AND p.user_id = e.owner_id)
          AND e.starts_at < $5::timestamptz AND e.ends_at > $4::timestamptz AND ($6::bigint IS NULL OR e.id <> $6::bigint)
       UNION ALL
       SELECT b.user_id::text, b.starts_at, b.ends_at, CASE WHEN b.kind = 'focus' THEN 'focus' ELSE 'meeting' END, NULL
         FROM calendar_blocks b
        WHERE b.tenant_id = $1 AND b.user_id = ANY($2::bigint[]) AND b.starts_at < $5::timestamptz AND b.ends_at > $4::timestamptz
          AND (b.kind = 'focus' OR b.user_id = $3::bigint)
       UNION ALL
       SELECT l.user_id::text, x.starts_at, x.ends_at, 'meeting', NULL
         FROM calendar_external_events x JOIN calendar_links l ON l.id = x.link_id
        WHERE x.tenant_id = $1 AND l.user_id = ANY($2::bigint[]) AND l.kind IN ('import', 'google', 'yandex') AND NOT x.all_day
          AND x.starts_at < $5::timestamptz AND x.ends_at > $4::timestamptz
       UNION ALL
       SELECT a.user_id::text, a.from_date::timestamptz, (a.to_date + 1)::timestamptz, 'away', NULL
         FROM user_availability a
        WHERE a.tenant_id = $1 AND a.user_id = ANY($2::bigint[])
          AND a.from_date::timestamptz < $5::timestamptz AND (a.to_date + 1)::timestamptz > $4::timestamptz`,
      [tenantId, userIds, meId, from, to, exceptEventId ?? null],
    );
  }

  /** Свои открытые задачи со сроком на горизонте — для «окна под задачу». */
  myOpenTasks(tenantId: string, userId: string, until: string) {
    return this.db.many<{ id: string; title: string; deadline_at: Date; estimate_hours: string | null; planned: boolean }>(
      `SELECT t.id::text, t.title, t.deadline_at, t.estimate_hours::text,
              EXISTS (SELECT 1 FROM calendar_blocks b WHERE b.task_id = t.id AND b.ends_at > now()) AS planned
         FROM tasks t
        WHERE t.tenant_id = $1 AND t.assignee_id = $2 AND t.deleted_at IS NULL AND t.closed_at IS NULL
          AND t.deadline_at IS NOT NULL AND t.deadline_at > now() AND t.deadline_at <= $3::timestamptz
        ORDER BY t.deadline_at LIMIT 30`,
      [tenantId, userId, until],
    );
  }

  /**
   * Открытые задачи по теме — для повестки: в названии есть слово темы, задача видна
   * человеку и касается кого-то из участников. Сначала просроченные.
   */
  tasksByTopic(tenantId: string, userId: string, boss: boolean, words: string[], peopleIds: string[], limit = 5) {
    if (!words.length) return Promise.resolve([] as { id: string; title: string; deadline_at: Date | null; overdue_days: number | null; assignee: string | null; project_id: string }[]);
    return this.db.many<{ id: string; title: string; deadline_at: Date | null; overdue_days: number | null; assignee: string | null; project_id: string }>(
      `SELECT t.id::text, t.title, t.deadline_at, t.project_id::text,
              CASE WHEN t.deadline_at < now() THEN floor(EXTRACT(EPOCH FROM now() - t.deadline_at) / 86400)::int END AS overdue_days,
              u.full_name AS assignee
         FROM tasks t JOIN projects p ON p.id = t.project_id
         LEFT JOIN users u ON u.id = t.assignee_id
        WHERE t.tenant_id = $1 AND t.deleted_at IS NULL AND t.closed_at IS NULL
          AND (t.title ILIKE ANY($4::text[]) OR p.name ILIKE ANY($4::text[]))
          AND ($6::bigint[] = '{}' OR t.assignee_id = ANY($6::bigint[]) OR t.created_by = ANY($6::bigint[]))
          AND ($3::boolean OR p.visibility = 'all' OR p.owner_user_id = $2::bigint OR t.assignee_id = $2::bigint OR t.created_by = $2::bigint
               OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $2::bigint))
        ORDER BY (t.deadline_at < now()) DESC NULLS LAST, t.deadline_at NULLS LAST LIMIT $5`,
      [tenantId, userId, boss, words.map((w) => `%${w}%`), limit, peopleIds],
    );
  }

  /** Последние сообщения людей в чате — из них повестка «из обсуждения». */
  chatLines(tenantId: string, chatId: string, limit = 20) {
    return this.db.many<{ id: string; author: string | null; body: string; created_at: Date }>(
      `SELECT m.id::text, u.full_name AS author, m.body, m.created_at
         FROM chat_messages m LEFT JOIN users u ON u.id = m.author_id
        WHERE m.tenant_id = $1 AND m.chat_id = $2 AND m.deleted_at IS NULL AND NOT m.is_ai AND m.author_id IS NOT NULL
          AND btrim(m.body) <> ''
        ORDER BY m.id DESC LIMIT $3`,
      [tenantId, chatId, limit],
    );
  }

  /** Участники чата — сотрудники; для встречи из чата. */
  chatMembers(tenantId: string, chatId: string) {
    return this.db.many<{ id: string; full_name: string }>(
      `SELECT u.id::text, u.full_name FROM chat_members cm JOIN users u ON u.id = cm.user_id JOIN roles r ON r.id = u.role_id
        WHERE cm.chat_id = $2 AND u.tenant_id = $1 AND u.is_active AND r.code <> 'client'
        ORDER BY u.full_name LIMIT 30`,
      [tenantId, chatId],
    );
  }

  /** Прошлая встреча с теми же людьми или на ту же тему — что договорились и что сделано. */
  previousMeeting(tenantId: string, eventId: string, title: string, peopleIds: string[]) {
    return this.db.one<{ meeting_id: string; title: string; happened_at: Date; event_id: string | null }>(
      `SELECT m.id::text AS meeting_id, m.title, COALESCE(m.happened_at, m.created_at) AS happened_at, m.event_id::text
         FROM meetings m
         LEFT JOIN calendar_events e ON e.id = m.event_id
        WHERE m.tenant_id = $1 AND m.status = 'done' AND (m.event_id IS NULL OR m.event_id <> $2::bigint)
          AND COALESCE(m.happened_at, m.created_at) < now()
          AND (
            (e.series_id IS NOT NULL AND e.series_id = (SELECT series_id FROM calendar_events WHERE id = $2::bigint))
            OR lower(m.title) = lower($3)
            OR (cardinality($4::bigint[]) >= 2 AND e.id IS NOT NULL AND (
                 SELECT count(*) FROM calendar_participants p WHERE p.event_id = e.id AND p.user_id = ANY($4::bigint[])
               ) >= LEAST(cardinality($4::bigint[]), 3))
          )
        ORDER BY COALESCE(m.happened_at, m.created_at) DESC LIMIT 1`,
      [tenantId, eventId, title, peopleIds],
    );
  }

  meetingAgreements(tenantId: string, meetingId: string) {
    return this.db.many<{ title: string; assignee: string | null; deadline_at: Date | null; task_id: string | null; done: boolean; project_id: string | null }>(
      `SELECT d.title, COALESCE(u.full_name, d.assignee_hint) AS assignee, COALESCE(t.deadline_at, d.deadline_at) AS deadline_at,
              d.task_id::text, (t.closed_at IS NOT NULL) AS done, t.project_id::text
         FROM meeting_task_drafts d
         LEFT JOIN tasks t ON t.id = d.task_id AND t.deleted_at IS NULL
         LEFT JOIN users u ON u.id = COALESCE(t.assignee_id, d.assignee_id)
        WHERE d.tenant_id = $1 AND d.meeting_id = $2 AND d.status <> 'rejected'
        ORDER BY d.id LIMIT 10`,
      [tenantId, meetingId],
    );
  }

  agenda(tenantId: string, eventId: string) {
    return this.db.one<{ body: string; facts: unknown; created_at: Date; edited_by: string | null; sent_at: Date | null; starts_at: Date }>(
      `SELECT body, facts, created_at, edited_by::text, sent_at, starts_at FROM meeting_agendas WHERE tenant_id = $1 AND event_id = $2`,
      [tenantId, eventId],
    );
  }

  async saveAgenda(tenantId: string, eventId: string, startsAt: Date, body: string, facts: unknown, editedBy: string | null) {
    await this.db.query(
      `INSERT INTO meeting_agendas (event_id, tenant_id, starts_at, body, facts, edited_by)
       VALUES ($2, $1, $3, $4, $5::jsonb, $6)
       ON CONFLICT (event_id) DO UPDATE SET starts_at = EXCLUDED.starts_at, body = EXCLUDED.body,
          facts = EXCLUDED.facts, edited_by = EXCLUDED.edited_by, created_at = now()`,
      [tenantId, eventId, startsAt, body.slice(0, 4000), JSON.stringify(facts ?? []), editedBy],
    );
  }

  markAgendaSent(tenantId: string, eventId: string) {
    return this.db.query(`UPDATE meeting_agendas SET sent_at = now() WHERE tenant_id = $1 AND event_id = $2`, [tenantId, eventId]);
  }

  setCreatedVia(tenantId: string, eventId: string, via: string) {
    return this.db.query(`UPDATE calendar_events SET created_via = $3 WHERE tenant_id = $1 AND id = $2`, [tenantId, eventId, via.slice(0, 16)]);
  }

  setSourceChat(tenantId: string, eventId: string, chatId: string, messageId: string | null) {
    return this.db.query(
      `UPDATE calendar_events SET source_chat_id = $3, source_chat_message_id = $4 WHERE tenant_id = $1 AND id = $2`,
      [tenantId, eventId, chatId, messageId],
    );
  }

  /** Материалы встречи: файлы события, протоколы прошлых встреч, связанные задачи. */
  eventFiles(tenantId: string, eventId: string) {
    return this.db.many<{ title: string; url: string | null }>(
      `SELECT g.file_name AS title, g.web_view_link AS url
         FROM google_drive_links g WHERE g.tenant_id = $1 AND g.entity_type = 'event' AND g.entity_id = $2::bigint
        ORDER BY g.id LIMIT 10`,
      [tenantId, eventId],
    );
  }

  // ---------- подготовка за N минут ----------

  /** Встречи, которым пора прислать подготовку: начало через prep_min (у каждого своё). */
  duePrep() {
    return this.db.many<{ tenant_id: string; event_id: string; user_id: string; title: string; starts_at: Date; ends_at: Date; public_id: string | null; meet_room_id: string | null; prep_min: number }>(
      `SELECT e.tenant_id::text, e.id::text AS event_id, p.user_id::text, e.title, e.starts_at, e.ends_at,
              CASE WHEN e.is_call THEN ml.public_id END AS public_id, e.meet_room_id,
              COALESCE(pr.prep_min, 10) AS prep_min
         FROM calendar_events e
         JOIN calendar_participants p ON p.event_id = e.id AND p.status <> 'declined'
         LEFT JOIN meet_guest_links ml ON ml.event_id = e.id AND ml.kind = 'meeting' AND ml.revoked_at IS NULL
         LEFT JOIN calendar_user_prefs pr ON pr.user_id = p.user_id
        WHERE NOT e.all_day AND COALESCE(pr.prep_min, 10) > 0
          AND e.starts_at > now() AND e.starts_at <= now() + make_interval(mins => COALESCE(pr.prep_min, 10))
          AND e.starts_at > now() + make_interval(mins => COALESCE(pr.prep_min, 10) - 2)
          AND (SELECT count(*) FROM calendar_participants x WHERE x.event_id = e.id AND x.status <> 'declined') >= 2
          AND NOT EXISTS (SELECT 1 FROM calendar_reminder_log r WHERE r.event_id = e.id AND r.user_id = p.user_id
                           AND r.minutes_before = -1 AND r.starts_at = e.starts_at)
        LIMIT 200`,
    );
  }

  markPrepSent(eventId: string, userId: string, startsAt: Date) {
    return this.db.query(
      `INSERT INTO calendar_reminder_log (event_id, user_id, minutes_before, starts_at) VALUES ($1, $2, -1, $3) ON CONFLICT DO NOTHING`,
      [eventId, userId, startsAt],
    );
  }

  // ---------- созвоны ----------

  callsInRange(tenantId: string, userId: string, from: string, to: string) {
    return this.db.many<{ id: string; room_id: string; chat_id: string | null; chat_title: string | null; started_at: Date; ended_at: Date | null; participants: number; meeting_id: string | null; meeting_status: string | null }>(
      `SELECT c.id::text, c.room_id, c.chat_id::text, ch.title AS chat_title, c.started_at, c.ended_at,
              cardinality(c.participant_ids) AS participants,
              m.id::text AS meeting_id, m.status AS meeting_status
         FROM call_log c
         LEFT JOIN chats ch ON ch.id = c.chat_id
         LEFT JOIN LATERAL (
           SELECT mm.id, mm.status FROM meetings mm
            WHERE mm.tenant_id = c.tenant_id AND mm.room_id = c.room_id
              AND COALESCE(mm.happened_at, mm.created_at) BETWEEN c.started_at - interval '1 hour' AND COALESCE(c.ended_at, now()) + interval '1 hour'
            ORDER BY mm.created_at DESC LIMIT 1
         ) m ON TRUE
        WHERE c.tenant_id = $1 AND $2::bigint = ANY(c.participant_ids)
          AND c.started_at < $4::timestamptz AND COALESCE(c.ended_at, now()) > $3::timestamptz
          AND NOT EXISTS (SELECT 1 FROM calendar_events e WHERE e.tenant_id = c.tenant_id AND e.meet_room_id = c.room_id)
          AND NOT EXISTS (SELECT 1 FROM meet_guest_links ml WHERE ml.tenant_id = c.tenant_id AND ml.room_id = c.room_id AND ml.event_id IS NOT NULL)
        ORDER BY c.started_at`,
      [tenantId, userId, from, to],
    );
  }

  // ---------- встреча из чата ----------

  recentProposal(chatId: string, hours: number) {
    return this.db.one<{ id: string }>(
      `SELECT id::text FROM chat_meeting_proposals WHERE chat_id = $1 AND created_at > now() - make_interval(hours => $2) ORDER BY id DESC LIMIT 1`,
      [chatId, hours],
    );
  }

  async createProposal(p: { tenantId: string; chatId: string; authorId: string; sourceMessageId: string | null; topic: string | null; minutes: number; memberIds: string[]; slots: unknown[] }) {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO chat_meeting_proposals (tenant_id, chat_id, author_id, source_message_id, topic, minutes, member_ids, slots)
       VALUES ($1, $2, $3, $4, $5, $6, $7::bigint[], $8::jsonb) RETURNING id::text`,
      [p.tenantId, p.chatId, p.authorId, p.sourceMessageId, p.topic, p.minutes, p.memberIds, JSON.stringify(p.slots)],
    );
    return row!.id;
  }

  proposal(tenantId: string, id: string) {
    return this.db.one<ProposalRow>(
      `SELECT id::text, tenant_id::text, chat_id::text, message_id::text, source_message_id::text, author_id::text, topic, minutes,
              member_ids::text[] AS member_ids, slots, votes, status, event_id::text, created_at
         FROM chat_meeting_proposals WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
  }

  attachProposalMessage(id: string, messageId: string) {
    return Promise.all([
      this.db.query(`UPDATE chat_meeting_proposals SET message_id = $2 WHERE id = $1`, [id, messageId]),
      this.db.query(`UPDATE chat_messages SET proposal_id = $1 WHERE id = $2`, [id, messageId]),
    ]);
  }

  saveVotes(id: string, votes: Record<string, string[]>) {
    return this.db.query(`UPDATE chat_meeting_proposals SET votes = $2::jsonb, updated_at = now() WHERE id = $1 AND status = 'open'`, [id, JSON.stringify(votes)]);
  }

  /** Назначить — один раз: второй щелчок не создаст вторую встречу. */
  async claimSchedule(id: string): Promise<boolean> {
    const r = await this.db.one<{ id: string }>(
      `UPDATE chat_meeting_proposals SET status = 'scheduled', updated_at = now() WHERE id = $1 AND status = 'open' RETURNING id::text`, [id]);
    return !!r;
  }

  finishProposal(id: string, eventId: string | null, status: 'scheduled' | 'open' | 'cancelled') {
    return this.db.query(`UPDATE chat_meeting_proposals SET status = $3, event_id = $2, updated_at = now() WHERE id = $1`, [id, eventId, status]);
  }
}
