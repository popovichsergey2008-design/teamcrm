import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { stageSql } from '../tasks/responsibility';
import { BriefService } from './brief.service';
import { classify } from './chat-digest-rules';
import { BotDelivery } from './bot-delivery.service';
import { buildCards, Connections, inMonth, isStale, MatrixTask, MINUTES, quadrantOf, StartCard, StartFacts, WeekCounts, weekMinutes, weekText } from './bot-start.rules';

/**
 * Стартовый экран QEVO Bot (#4893, п. 1): вместо десяти одинаковых для всех разделов —
 * 3–4 карточки по данным человека на эту минуту («3 встречи сегодня — к одной нет
 * повестки», «27 решений ждут вас»…), у каждой одна кнопка результата. Пересчитывается
 * при каждом открытии; карточки без данных не показываются.
 */
@Injectable()
export class BotStartService {
  private readonly log = new Logger('BotStart');

  constructor(private readonly db: DbService, private readonly briefs: BriefService, private readonly delivery: BotDelivery) {}

  async connections(tenantId: string, userId: string): Promise<Connections> {
    const r = await this.db.one<{ mail: boolean; google: boolean; caldav: boolean; telegram: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM mail_accounts WHERE tenant_id = $1 AND user_id = $2) AS mail,
              EXISTS (SELECT 1 FROM google_accounts WHERE tenant_id = $1 AND user_id = $2
                        AND 'https://www.googleapis.com/auth/calendar.events' = ANY(scopes)) AS google,
              EXISTS (SELECT 1 FROM calendar_caldav_accounts WHERE tenant_id = $1 AND user_id = $2) AS caldav,
              EXISTS (SELECT 1 FROM telegram_accounts WHERE tenant_id = $1 AND user_id = $2) AS telegram`,
      [tenantId, userId]).catch((e) => { this.log.warn(`подключения: ${(e as Error).message}`); return null; });
    return { mail: !!r?.mail, calendar: !!(r?.google || r?.caldav), telegram: !!r?.telegram };
  }

  private async facts(tenantId: string, userId: string, tz: string): Promise<StartFacts> {
    const q = await this.db.one<{
      meetings: number; no_agenda: number; first_no_agenda: string | null; approvals: number; reviews: number;
      reports: number; report_chats: string[] | null; project: string | null; members: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM calendar_events e
            JOIN calendar_participants cp ON cp.event_id = e.id AND cp.user_id = $2 AND cp.status <> 'declined'
           WHERE e.tenant_id = $1 AND NOT e.all_day
             AND (e.starts_at AT TIME ZONE $3)::date = (now() AT TIME ZONE $3)::date AND e.ends_at > now()) AS meetings,
         (SELECT count(*)::int FROM calendar_events e
            JOIN calendar_participants cp ON cp.event_id = e.id AND cp.user_id = $2 AND cp.status <> 'declined'
           WHERE e.tenant_id = $1 AND NOT e.all_day
             AND (e.starts_at AT TIME ZONE $3)::date = (now() AT TIME ZONE $3)::date AND e.ends_at > now()
             AND coalesce(btrim(e.description), '') = '') AS no_agenda,
         (SELECT e.title FROM calendar_events e
            JOIN calendar_participants cp ON cp.event_id = e.id AND cp.user_id = $2 AND cp.status <> 'declined'
           WHERE e.tenant_id = $1 AND NOT e.all_day
             AND (e.starts_at AT TIME ZONE $3)::date = (now() AT TIME ZONE $3)::date AND e.ends_at > now()
             AND coalesce(btrim(e.description), '') = '' ORDER BY e.starts_at LIMIT 1) AS first_no_agenda,
         (SELECT count(*)::int FROM approvals a WHERE a.tenant_id = $1 AND a.approver_id = $2 AND a.status = 'pending') AS approvals,
         (SELECT count(*)::int FROM tasks t JOIN board_columns bc ON bc.id = t.column_id
           WHERE t.tenant_id = $1 AND t.created_by = $2 AND t.assignee_id IS NOT NULL AND t.assignee_id <> $2
             AND t.closed_at IS NULL AND t.deleted_at IS NULL
             AND ${stageSql('t')} IN ('testing', 'review', 'approval')) AS reviews,
         (SELECT count(DISTINCT m.author_id)::int FROM chat_messages m JOIN chats c ON c.id = m.chat_id
            JOIN chat_members me ON me.chat_id = c.id AND me.user_id = $2
           WHERE m.tenant_id = $1 AND m.author_id <> $2
             AND (m.created_at AT TIME ZONE $3)::date = (now() AT TIME ZONE $3)::date - 1
             AND (c.title ILIKE '%отч_т%' OR m.body ILIKE 'отч_т%' OR m.body ILIKE '%отч_т за%')) AS reports,
         ARRAY(SELECT DISTINCT c.title FROM chats c JOIN chat_members me ON me.chat_id = c.id AND me.user_id = $2
                WHERE c.tenant_id = $1 AND c.title ILIKE '%отч_т%' LIMIT 2) AS report_chats,
         (SELECT p.name FROM tasks t JOIN projects p ON p.id = t.project_id
           WHERE t.tenant_id = $1 AND (t.assignee_id = $2 OR t.created_by = $2) AND NOT p.is_demo
           ORDER BY t.updated_at DESC LIMIT 1) AS project,
         (SELECT count(*)::int FROM users u WHERE u.tenant_id = $1 AND u.is_active) AS members`,
      [tenantId, userId, tz]);
    let needReply = 0;
    try { needReply = classify(await this.briefs.digest(tenantId, userId)).needReply.length; }
    catch (e) { this.log.warn(`ждут ответа: ${(e as Error).message}`); }
    return {
      meetings: q?.meetings ?? 0, noAgenda: q?.no_agenda ?? 0, firstNoAgenda: q?.first_no_agenda ?? null,
      decisions: (q?.approvals ?? 0) + (q?.reviews ?? 0), needReply, reports: q?.reports ?? 0,
      reportChats: q?.report_chats ?? [], project: q?.project ?? null, members: q?.members ?? 1,
    };
  }

  async start(tenantId: string, userId: string, tz: string | null) {
    const zone = tz || 'Europe/Moscow';
    const [facts, connections] = await Promise.all([this.facts(tenantId, userId, zone), this.connections(tenantId, userId)]);
    const cards: StartCard[] = buildCards(facts, connections);
    const month = new Intl.DateTimeFormat('ru-RU', { timeZone: zone, month: 'long' }).format(new Date(Date.now() - 20 * 86_400_000));
    const example = facts.project ? `что решили про «${facts.project}» в ${inMonth(month)}?` : 'что решили на последней встрече?';
    return { cards, example, connections };
  }

  /** п. 6: запуск сценария из каталога — для «Популярного в вашей компании». */
  async scenarioRun(tenantId: string, userId: string, id: string) {
    if (!/^[a-z0-9-]{2,60}$/.test(id)) return { ok: false };
    await this.db.query(`INSERT INTO bot_scenario_runs (tenant_id, user_id, scenario_id) VALUES ($1, $2, $3)`, [tenantId, userId, id]);
    return { ok: true };
  }

  popular(tenantId: string) {
    return this.db.many<{ id: string; n: number }>(
      `SELECT scenario_id AS id, count(DISTINCT user_id)::int AS n FROM bot_scenario_runs
        WHERE tenant_id = $1 AND created_at > now() - interval '30 days'
        GROUP BY scenario_id ORDER BY n DESC, count(*) DESC LIMIT 5`, [tenantId]);
  }

  // ── п. 10: матрица Эйзенхауэра ──

  /** Мои открытые задачи по квадрантам — правилами; перенести между квадратами можно на экране. */
  async matrix(tenantId: string, userId: string) {
    const rows = await this.db.many<{ id: string; title: string; project_name: string | null; deadline_at: Date | null; priority: string | null; updated_at: Date; blocks: boolean; project_id: string }>(
      `SELECT t.id::text, t.title, p.name AS project_name, t.deadline_at, t.priority, t.updated_at, t.project_id::text,
              EXISTS (SELECT 1 FROM task_links l JOIN tasks o ON o.id = l.task_id AND o.closed_at IS NULL WHERE l.depends_on_id = t.id) AS blocks
         FROM tasks t JOIN projects p ON p.id = t.project_id
        WHERE t.tenant_id = $1 AND t.assignee_id = $2 AND t.closed_at IS NULL AND t.deleted_at IS NULL AND NOT p.is_demo
        ORDER BY t.deadline_at NULLS LAST, t.updated_at DESC LIMIT 60`, [tenantId, userId]);
    const now = new Date();
    return rows.map((r) => {
      const t: MatrixTask = { id: r.id, title: r.title, projectName: r.project_name, deadlineAt: r.deadline_at, priority: r.priority, updatedAt: r.updated_at, blocksOthers: r.blocks };
      return { id: r.id, title: r.title, projectId: r.project_id, projectName: r.project_name, deadlineAt: r.deadline_at, priority: r.priority, quadrant: quadrantOf(t, now), stale: isStale(t, now) };
    });
  }

  // ── п. 11: бот за неделю ──

  /** Что бот сделал за 7 дней — из того же журнала действий, что «Как бот действует» в Настройках. */
  async week(tenantId: string, userId: string) {
    const r = await this.db.one<{ tasks: number; meetings: number; mail: number; reminders: number; summaries: number; meeting_tasks: number }>(
      `SELECT
         (SELECT count(*)::int FROM ai_tool_actions a WHERE a.tenant_id = $1 AND a.user_id = $2 AND a.status = 'done' AND a.created_at > now() - interval '7 days' AND a.tool = 'create_task') AS tasks,
         (SELECT count(*)::int FROM ai_tool_actions a WHERE a.tenant_id = $1 AND a.user_id = $2 AND a.status = 'done' AND a.created_at > now() - interval '7 days' AND a.tool = 'create_event') AS meetings,
         (SELECT count(*)::int FROM ai_tool_actions a WHERE a.tenant_id = $1 AND a.user_id = $2 AND a.status = 'done' AND a.created_at > now() - interval '7 days' AND a.tool LIKE 'mail\_%') AS mail,
         (SELECT count(*)::int FROM ai_tool_actions a WHERE a.tenant_id = $1 AND a.user_id = $2 AND a.status = 'done' AND a.created_at > now() - interval '7 days' AND a.tool = 'create_reminder') AS reminders,
         (SELECT count(*)::int FROM ai_messages m JOIN ai_sessions s ON s.id = m.session_id
           WHERE s.tenant_id = $1 AND s.user_id = $2 AND m.role = 'assistant' AND m.created_at > now() - interval '7 days'
             AND m.tools::text ~ '"(chat_digest|team_pulse|staff_reports|time_audit|news_today|my_day|mail_inbox|whats_missed|get_meeting)"') AS summaries,
         (SELECT count(*)::int FROM meeting_task_drafts d JOIN tasks t ON t.id = d.task_id
           WHERE d.tenant_id = $1 AND d.status = 'applied' AND t.created_by = $2 AND t.created_at > now() - interval '7 days') AS meeting_tasks`,
      [tenantId, userId]);
    const c: WeekCounts = { summaries: r?.summaries ?? 0, meetingTasks: r?.meeting_tasks ?? 0, meetings: r?.meetings ?? 0, mail: r?.mail ?? 0, tasks: r?.tasks ?? 0, reminders: r?.reminders ?? 0 };
    const used = await this.db.many<{ scenario_id: string }>(`SELECT DISTINCT scenario_id FROM bot_scenario_runs WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]);
    return {
      counts: c, minutes: weekMinutes(c), text: weekText(c),
      method: (Object.keys(MINUTES) as (keyof WeekCounts)[]).map((k) => ({ key: k, minutes: MINUTES[k].min, what: MINUTES[k].what })),
      used: used.map((u) => u.scenario_id),
    };
  }

  /** Понедельник, 9:00–10:00 по поясу человека: карточка «Бот за неделю» в «Заметки» и Telegram. */
  async weeklyTick(): Promise<number> {
    const users = await this.db.many<{ tenant_id: string; user_id: string; tz: string | null }>(
      `SELECT DISTINCT s.tenant_id::text, s.user_id::text, u.timezone AS tz
         FROM ai_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.updated_at > now() - interval '14 days' AND u.is_active`);
    let sent = 0;
    for (const u of users) {
      const zone = u.tz || 'Europe/Moscow';
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', hour: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(new Date()).map((p) => [p.type, p.value]));
      if (parts.weekday !== 'Mon' || Number(parts.hour) !== 9) continue;
      const week = `${parts.year}-${parts.month}-${parts.day}`;
      const claimed = await this.db.one<{ week: string }>(
        `INSERT INTO bot_week_sends (user_id, week) VALUES ($1, $2::date) ON CONFLICT DO NOTHING RETURNING week::text`, [u.user_id, week]);
      if (!claimed) continue;
      try {
        const w = await this.week(u.tenant_id, u.user_id);
        if (!w.minutes) continue;
        await this.delivery.send(u.tenant_id, u.user_id, { eventKey: 'anthill.week', title: 'QEVO Bot за неделю', body: `${w.text}\nЧто ещё поручить — откройте QEVO Bot.` });
        sent++;
      } catch (e) { this.log.warn(`бот за неделю ${u.user_id}: ${(e as Error).message}`); }
    }
    return sent;
  }
}
