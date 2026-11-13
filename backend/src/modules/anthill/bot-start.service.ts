import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { stageSql } from '../tasks/responsibility';
import { BriefService } from './brief.service';
import { classify } from './chat-digest-rules';
import { buildCards, Connections, inMonth, StartCard, StartFacts } from './bot-start.rules';

/**
 * Стартовый экран QEVO Bot (#4893, п. 1): вместо десяти одинаковых для всех разделов —
 * 3–4 карточки по данным человека на эту минуту («3 встречи сегодня — к одной нет
 * повестки», «27 решений ждут вас»…), у каждой одна кнопка результата. Пересчитывается
 * при каждом открытии; карточки без данных не показываются.
 */
@Injectable()
export class BotStartService {
  private readonly log = new Logger('BotStart');

  constructor(private readonly db: DbService, private readonly briefs: BriefService) {}

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
}
