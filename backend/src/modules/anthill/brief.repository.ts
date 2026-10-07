import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { REVIEW_COLUMN_NAMES } from '../tasks/task-columns';
import { BriefMeeting, BriefTask, EveningData, MorningData } from './brief-rules';
import { DigestMessage, Unanswered } from './chat-digest-rules';

export interface PrefsRow {
  user_id: string; tenant_id: string; morning_at: string | null; evening_at: string | null;
  weekdays_only: boolean; channels: { push?: boolean; telegram?: boolean } | null;
  meeting_brief_min: number | null; vip_user_ids: string[];
  last_morning: string | null; last_evening: string | null;
}

/** Открытая задача человека — общий кусок условий для сводок. */
const OPEN_MINE = `t.tenant_id = $1 AND t.assignee_id = $2 AND t.closed_at IS NULL AND t.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM projects p WHERE p.id = t.project_id AND p.status <> 'archived')`;

/**
 * Данные личных сводок (ТЗ-18) — только то, что человек и так видит на своих экранах:
 * свои задачи, свои встречи, свои согласования, свои личные чаты.
 */
@Injectable()
export class BriefRepository {
  constructor(private readonly db: DbService) {}

  prefs(userId: string): Promise<PrefsRow | null> {
    return this.db.one<PrefsRow>(
      `SELECT user_id, tenant_id, to_char(morning_at, 'HH24:MI') AS morning_at, to_char(evening_at, 'HH24:MI') AS evening_at,
              weekdays_only, channels, meeting_brief_min, vip_user_ids::text[] AS vip_user_ids,
              last_morning::text AS last_morning, last_evening::text AS last_evening
         FROM secretary_prefs WHERE user_id = $1`,
      [userId],
    );
  }

  async savePrefs(tenantId: string, userId: string, p: {
    morningAt: string | null; eveningAt: string | null; weekdaysOnly: boolean;
    channels: { push: boolean; telegram: boolean }; meetingBriefMin: number | null; vipUserIds: string[];
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO secretary_prefs (user_id, tenant_id, morning_at, evening_at, weekdays_only, channels, meeting_brief_min, vip_user_ids)
       VALUES ($1, $2, $3::time, $4::time, $5, $6::jsonb, $7::int, $8::bigint[])
       ON CONFLICT (user_id) DO UPDATE SET
         morning_at = $3::time, evening_at = $4::time, weekdays_only = $5, channels = $6::jsonb,
         meeting_brief_min = $7::int, vip_user_ids = $8::bigint[], updated_at = now()`,
      [userId, tenantId, p.morningAt, p.eveningAt, p.weekdaysOnly, JSON.stringify(p.channels), p.meetingBriefMin, p.vipUserIds],
    );
  }

  /** У кого включена хоть одна сводка — с поясом человека (или компании). */
  scheduled(): Promise<(PrefsRow & { timezone: string | null; role: string })[]> {
    return this.db.many<PrefsRow & { timezone: string | null; role: string }>(
      `SELECT s.user_id, s.tenant_id, to_char(s.morning_at, 'HH24:MI') AS morning_at, to_char(s.evening_at, 'HH24:MI') AS evening_at,
              s.weekdays_only, s.channels, s.meeting_brief_min, s.vip_user_ids::text[] AS vip_user_ids,
              s.last_morning::text AS last_morning, s.last_evening::text AS last_evening,
              COALESCE(u.timezone, t.timezone) AS timezone, u.role
         FROM secretary_prefs s
         JOIN users u ON u.id = s.user_id AND u.is_active
         JOIN tenants t ON t.id = s.tenant_id
        WHERE s.morning_at IS NOT NULL OR s.evening_at IS NOT NULL`,
    );
  }

  /**
   * Занять отправку сводки на эту местную дату. Синий и зелёный экземпляры во время
   * выкладки проходят одновременно — сводку получит тот, кто первым поставил дату.
   */
  async claim(userId: string, kind: 'morning' | 'evening', date: string): Promise<boolean> {
    const col = kind === 'morning' ? 'last_morning' : 'last_evening';
    const r = await this.db.query(
      `UPDATE secretary_prefs SET ${col} = $2::date WHERE user_id = $1 AND (${col} IS NULL OR ${col} < $2::date)`,
      [userId, date],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async morning(tenantId: string, userId: string, from: Date, to: Date): Promise<MorningData> {
    const task = (r: any): BriefTask => ({ id: String(r.id), title: r.title, projectId: String(r.project_id), deadlineAt: r.deadline_at });
    const [meetings, overdue, dueToday, blocked, decisions, dms] = await Promise.all([
      this.db.many<BriefMeeting & { starts_at: Date }>(
        `SELECT DISTINCT e.id, e.title, e.starts_at FROM calendar_events e
           JOIN calendar_participants cp ON cp.event_id = e.id AND cp.user_id = $2 AND cp.status <> 'declined'
          WHERE e.tenant_id = $1 AND NOT e.all_day AND e.starts_at >= $3 AND e.starts_at < $4
          ORDER BY e.starts_at LIMIT 20`,
        [tenantId, userId, from, to],
      ),
      this.db.many(`SELECT t.id, t.title, t.project_id, t.deadline_at FROM tasks t WHERE ${OPEN_MINE} AND t.deadline_at < now() ORDER BY t.deadline_at LIMIT 50`, [tenantId, userId]),
      this.db.many(`SELECT t.id, t.title, t.project_id, t.deadline_at FROM tasks t WHERE ${OPEN_MINE} AND t.deadline_at >= now() AND t.deadline_at < $3 ORDER BY t.deadline_at LIMIT 50`, [tenantId, userId, to]),
      this.db.many(`SELECT t.id, t.title, t.project_id FROM tasks t WHERE ${OPEN_MINE} AND t.is_blocked LIMIT 50`, [tenantId, userId]),
      this.db.one<{ approvals: number; reviews: number; shifts: number }>(
        `SELECT
           (SELECT count(*)::int FROM approvals a WHERE a.tenant_id = $1 AND a.approver_id = $2 AND a.status = 'pending') AS approvals,
           (SELECT count(*)::int FROM tasks t JOIN board_columns bc ON bc.id = t.column_id
             WHERE t.tenant_id = $1 AND t.created_by = $2 AND (t.assignee_id IS NULL OR t.assignee_id <> $2)
               AND t.closed_at IS NULL AND t.deleted_at IS NULL AND lower(bc.name) = ANY($3::text[])) AS reviews,
           (SELECT count(*)::int FROM tasks t WHERE t.tenant_id = $1 AND t.created_by = $2 AND t.deadline_shift_to IS NOT NULL
               AND t.closed_at IS NULL AND t.deleted_at IS NULL) AS shifts`,
        [tenantId, userId, REVIEW_COLUMN_NAMES],
      ),
      this.db.many<{ name: string; count: number }>(
        `SELECT peer.full_name AS name, count(*)::int AS count
           FROM chats c
           JOIN chat_members me ON me.chat_id = c.id AND me.user_id = $2
           JOIN chat_messages msg ON msg.chat_id = c.id AND msg.deleted_at IS NULL AND msg.author_id <> $2
                AND (me.last_read_at IS NULL OR msg.created_at > me.last_read_at)
                AND msg.created_at > now() - interval '7 days'
           JOIN users peer ON peer.id = msg.author_id
          WHERE c.tenant_id = $1 AND c.kind = 'dm'
          GROUP BY peer.full_name ORDER BY count(*) DESC LIMIT 10`,
        [tenantId, userId],
      ),
    ]);
    return {
      meetings: meetings.map((m) => ({ title: m.title, startsAt: m.starts_at })),
      overdue: overdue.map(task), dueToday: dueToday.map(task), blocked: blocked.map(task),
      decisions: { approvals: Number(decisions?.approvals ?? 0), reviews: Number(decisions?.reviews ?? 0), shifts: Number(decisions?.shifts ?? 0) },
      unreadDms: dms.map((x) => ({ name: x.name, count: Number(x.count) })),
    };
  }

  /**
   * Встречи, до которых осталось ровно «за сколько минут» человек просил справку
   * (окно ±1 минута — планировщик ходит раз в минуту), и по которым справки ещё не было.
   */
  dueMeetingBriefs(): Promise<{
    user_id: string; tenant_id: string; event_id: string; title: string; description: string | null;
    starts_at: Date; minutes: number; client: string | null; public_id: string | null; channels: PrefsRow['channels'];
  }[]> {
    return this.db.many(
      `SELECT s.user_id, s.tenant_id, e.id AS event_id, e.title, e.description, e.starts_at, s.meeting_brief_min AS minutes,
              c.name AS client, l.public_id, s.channels
         FROM secretary_prefs s
         JOIN users u ON u.id = s.user_id AND u.is_active
         JOIN calendar_participants cp ON cp.user_id = s.user_id AND cp.status <> 'declined'
         JOIN calendar_events e ON e.id = cp.event_id AND e.tenant_id = s.tenant_id AND NOT e.all_day
         LEFT JOIN clients c ON c.id = e.client_id
         LEFT JOIN LATERAL (
           SELECT g.public_id FROM meet_guest_links g WHERE g.event_id = e.id AND g.kind = 'meeting' LIMIT 1
         ) l ON TRUE
        WHERE s.meeting_brief_min IS NOT NULL
          AND e.starts_at >  now() + make_interval(mins => s.meeting_brief_min - 1)
          AND e.starts_at <= now() + make_interval(mins => s.meeting_brief_min + 1)
          AND NOT EXISTS (
            SELECT 1 FROM secretary_sent x
             WHERE x.user_id = s.user_id AND x.kind = 'meeting_brief'
               AND x.ref = e.id::text || ':' || extract(epoch FROM e.starts_at)::bigint::text)
        LIMIT 200`,
    );
  }

  /** Занять отправку: вставил строку — шлёт этот экземпляр; строка уже была — кто-то успел раньше. */
  async claimSent(userId: string, kind: string, ref: string): Promise<boolean> {
    const r = await this.db.query(
      `INSERT INTO secretary_sent (user_id, kind, ref) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [userId, kind, ref],
    );
    return (r.rowCount ?? 0) > 0;
  }

  eventParticipants(eventId: string): Promise<{ user_id: string; full_name: string }[]> {
    return this.db.many(
      `SELECT cp.user_id, u.full_name FROM calendar_participants cp JOIN users u ON u.id = cp.user_id
        WHERE cp.event_id = $1 AND cp.status <> 'declined' ORDER BY cp.is_organizer DESC, u.full_name`,
      [eventId],
    );
  }

  /**
   * Непрочитанное за двое суток в чатах, где человек участник (§8.3). Чаты проектов
   * без строки участия не берём: там «непрочитано всё», и сводка утонула бы в шуме.
   */
  digestRows(tenantId: string, userId: string): Promise<DigestMessage[]> {
    return this.db.many<any>(
      `SELECT m.id::text, m.chat_id::text AS "chatId", c.kind AS "chatKind", COALESCE(c.title, p.name) AS "chatTitle",
              COALESCE(u.full_name, 'кто-то') AS author, m.body, m.created_at AS "createdAt",
              EXISTS (SELECT 1 FROM chat_mentions n WHERE n.message_id = m.id AND n.user_id = $2) AS "mentionsMe"
         FROM chat_members me
         JOIN chats c ON c.id = me.chat_id AND c.tenant_id = $1
    LEFT JOIN projects p ON p.id = c.project_id
         JOIN chat_messages m ON m.chat_id = c.id AND m.deleted_at IS NULL AND m.author_id IS NOT NULL AND m.author_id <> $2
              AND NOT m.is_ai
              AND (m.thread_root_id IS NULL OR m.also_in_channel)
              AND (me.last_read_at IS NULL OR m.created_at > me.last_read_at)
              AND m.created_at > now() - interval '48 hours'
    LEFT JOIN users u ON u.id = m.author_id
        WHERE me.user_id = $2 AND COALESCE(me.notify, 'all') <> 'none'
        ORDER BY m.created_at DESC
        LIMIT 300`,
      [tenantId, userId],
    ).then((rows) => rows.map((r) => ({ ...r, body: String(r.body ?? '') })));
  }

  /**
   * Мои вопросы без ответа (§8.4): последний вопрос в личке или с упоминанием, после
   * которого собеседник не написал в этом чате ни слова. Старше N дней, но не
   * старше двух недель — дальше это уже не «напомнить», а «забыто».
   */
  unanswered(tenantId: string, userId: string, days = 3): Promise<Unanswered[]> {
    return this.db.many<any>(
      `WITH asked AS (
         SELECT DISTINCT ON (m.chat_id, target.id)
                m.id, m.chat_id, c.kind, COALESCE(c.title, p.name) AS chat_title, m.body, m.created_at, target.id AS to_id, target.full_name AS to_name
           FROM chat_messages m
           JOIN chats c ON c.id = m.chat_id AND c.tenant_id = $1
      LEFT JOIN projects p ON p.id = c.project_id
           JOIN LATERAL (
             SELECT u.id, u.full_name FROM chat_members x JOIN users u ON u.id = x.user_id
              WHERE c.kind = 'dm' AND x.chat_id = c.id AND x.user_id <> $2
             UNION
             SELECT u.id, u.full_name FROM chat_mentions n JOIN users u ON u.id = n.user_id
              WHERE n.message_id = m.id AND n.user_id <> $2
           ) target ON TRUE
          WHERE m.author_id = $2 AND m.deleted_at IS NULL AND NOT m.is_ai
            -- классы символов, а не «\?» и «\s»: в шаблонной строке TS обратный слэш теряется
            AND (m.body ~ '[?]' OR m.body ~* '^[[:space:]]*(когда|где|кто|почему|сколько|можешь|можете|сможешь|сможете|подскажи)')
            AND m.created_at < now() - make_interval(days => $3::int)
            AND m.created_at > now() - interval '14 days'
          ORDER BY m.chat_id, target.id, m.created_at DESC
       )
       SELECT a.chat_id::text AS "chatId", a.kind AS "chatKind", a.chat_title AS "chatTitle", a.to_name AS "to", a.body,
              GREATEST(1, (EXTRACT(EPOCH FROM (now() - a.created_at)) / 86400)::int) AS days
         FROM asked a
        WHERE NOT EXISTS (
          SELECT 1 FROM chat_messages r WHERE r.chat_id = a.chat_id AND r.author_id = a.to_id AND r.created_at > a.created_at AND r.deleted_at IS NULL)
          AND NOT EXISTS (
          -- я сам уже написал позже в этот чат — значит, разговор пошёл дальше
          SELECT 1 FROM chat_messages r WHERE r.chat_id = a.chat_id AND r.author_id = $2 AND r.created_at > a.created_at AND r.deleted_at IS NULL AND r.id <> a.id)
        ORDER BY days DESC
        LIMIT 20`,
      [tenantId, userId, days],
    ).then((rows) => rows.map((r) => ({ ...r, days: Number(r.days) })));
  }

  /** Куда ушла неделя (§7.4): встречи, глубокая работа, трекер, закрытое, просроченное. */
  async week(tenantId: string, userId: string, from: Date, to: Date) {
    const row = await this.db.one<{ meetings: number; deep: number; tracked: number; closed: number; overdue: number }>(
      `SELECT
         (SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (LEAST(e.ends_at, $4) - GREATEST(e.starts_at, $3))) / 60), 0)::int
            FROM (SELECT DISTINCT e.id, e.starts_at, e.ends_at FROM calendar_events e
                    JOIN calendar_participants cp ON cp.event_id = e.id AND cp.user_id = $2 AND cp.status <> 'declined'
                   WHERE e.tenant_id = $1 AND NOT e.all_day AND e.starts_at < $4 AND e.ends_at > $3) e) AS meetings,
         (SELECT COALESCE(SUM(LEAST(s.planned_minutes, EXTRACT(EPOCH FROM (COALESCE(s.ended_at, now()) - s.started_at)) / 60)), 0)::int
            FROM focus_sessions s
           WHERE s.tenant_id = $1 AND s.user_id = $2 AND s.status IN ('completed', 'running', 'paused')
             AND s.started_at >= $3 AND s.started_at < $4) AS deep,
         (SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(l.timestamp_end, now()) - l.timestamp_start)) / 60), 0)::int
            FROM time_logs l WHERE l.tenant_id = $1 AND l.user_id = $2 AND l.timestamp_start >= $3 AND l.timestamp_start < $4) AS tracked,
         (SELECT count(*)::int FROM tasks t
           WHERE t.tenant_id = $1 AND t.assignee_id = $2 AND t.deleted_at IS NULL AND t.closed_at >= $3 AND t.closed_at < $4) AS closed,
         (SELECT count(*)::int FROM tasks t WHERE ${OPEN_MINE} AND t.deadline_at < now()) AS overdue`,
      [tenantId, userId, from, to],
    );
    return {
      meetingMinutes: Number(row?.meetings ?? 0), deepMinutes: Number(row?.deep ?? 0), trackedMinutes: Number(row?.tracked ?? 0),
      closed: Number(row?.closed ?? 0), overdueNow: Number(row?.overdue ?? 0),
    };
  }

  async evening(tenantId: string, userId: string, from: Date, to: Date): Promise<EveningData> {
    const task = (r: any): BriefTask => ({ id: String(r.id), title: r.title, projectId: String(r.project_id) });
    const tomorrowEnd = new Date(to.getTime() + 24 * 3600_000);
    const [done, shifted, blocked, tomorrow, meetings] = await Promise.all([
      this.db.many(
        `SELECT t.id, t.title, t.project_id FROM tasks t
          WHERE t.tenant_id = $1 AND t.assignee_id = $2 AND t.deleted_at IS NULL AND t.closed_at >= $3 AND t.closed_at < $4
          ORDER BY t.closed_at LIMIT 50`,
        [tenantId, userId, from, to],
      ),
      this.db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM task_activity a JOIN tasks t ON t.id = a.task_id
          WHERE a.tenant_id = $1 AND t.assignee_id = $2 AND a.kind = 'deadline_shifted' AND a.created_at >= $3 AND a.created_at < $4`,
        [tenantId, userId, from, to],
      ),
      this.db.many(`SELECT t.id, t.title, t.project_id FROM tasks t WHERE ${OPEN_MINE} AND t.is_blocked LIMIT 50`, [tenantId, userId]),
      this.db.many(`SELECT t.id, t.title, t.project_id FROM tasks t WHERE ${OPEN_MINE} AND t.deadline_at >= $3 AND t.deadline_at < $4 ORDER BY t.deadline_at LIMIT 50`, [tenantId, userId, to, tomorrowEnd]),
      this.db.one<{ n: number }>(
        `SELECT count(DISTINCT e.id)::int AS n FROM calendar_events e
           JOIN calendar_participants cp ON cp.event_id = e.id AND cp.user_id = $2 AND cp.status <> 'declined'
          WHERE e.tenant_id = $1 AND NOT e.all_day AND e.starts_at >= $3 AND e.starts_at < $4`,
        [tenantId, userId, to, tomorrowEnd],
      ),
    ]);
    return {
      done: done.map(task), shifted: Number(shifted?.n ?? 0), blocked: blocked.map(task),
      tomorrow: tomorrow.map(task), meetingsTomorrow: Number(meetings?.n ?? 0),
    };
  }
}
