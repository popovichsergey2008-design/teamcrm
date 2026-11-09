import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { DbService } from '../../database/db.service';
import { AiCounts, aiHint, aiLine, aiTip } from './ai-stats-rules';

/**
 * Строка пользы ИИ под «AI-агентом» (#4807 §7).
 *
 * Источник — журнал действий ИИ (ai_actions), который уже пишут постановка из
 * фразы/голоса/сообщения (nl_task), поручения из созвона (meeting_task) и протоколы
 * (meeting_summary); «план дня» — открытый брифинг «Фокуса дня». Только подтверждённое
 * и только своё: задача, удалённая в первые 10 минут, не считается; одна задача — раз.
 * Период — сегодня по часовому поясу человека.
 */
@ApiTags('ai')
@ApiBearerAuth()
@Controller('ai/stats')
@Roles('owner', 'manager', 'member')
export class AiStatsController {
  constructor(private readonly db: DbService) {}

  @Get()
  async stats(@CurrentUser() u: AuthUser) {
    const [today, week, used] = await Promise.all([this.counts(u, 0), this.counts(u, 6), this.usedDays(u)]);
    return { line: aiLine(today), hint: aiHint(today, used, new Date()), tip: aiTip(today, week), today, week };
  }

  /** Показатели с начала дня (days = 0) или за последние days + 1 дней — в поясе человека. */
  private async counts(u: AuthUser, days: number): Promise<AiCounts> {
    const r = await this.db.one<Record<string, string>>(
      `WITH me AS (
         SELECT COALESCE(NULLIF(u.timezone, ''), 'Europe/Moscow') AS tz FROM users u WHERE u.id = $2::bigint),
       since AS (
         SELECT (date_trunc('day', now() AT TIME ZONE me.tz) - make_interval(days => $3::int)) AT TIME ZONE me.tz AS t FROM me)
       SELECT
         (SELECT count(DISTINCT a.subject_id) FROM ai_actions a
            JOIN tasks t ON t.id = a.subject_id::bigint AND t.tenant_id = a.tenant_id
           WHERE a.tenant_id = $1 AND a.user_id = $2::bigint AND a.kind IN ('nl_task', 'meeting_task') AND a.subject_type = 'task'
             AND a.created_at >= (SELECT t FROM since)
             AND (t.deleted_at IS NULL OR t.deleted_at > t.created_at + interval '10 minutes'))::text AS tasks,
         (SELECT count(DISTINCT m.id) FROM meetings m
            JOIN meeting_summaries s ON s.meeting_id = m.id
           WHERE m.tenant_id = $1 AND s.created_at >= (SELECT t FROM since)
             AND (m.created_by = $2::bigint OR EXISTS (SELECT 1 FROM meeting_tracks mt WHERE mt.meeting_id = m.id AND mt.user_id = $2::bigint)))::text AS protocols,
         (SELECT count(DISTINCT a.subject_id) FROM ai_actions a
           WHERE a.tenant_id = $1 AND a.user_id = $2::bigint AND a.kind = 'meeting_task'
             AND a.created_at >= (SELECT t FROM since))::text AS items,
         (SELECT count(*) FROM focus_brief_events e
           WHERE e.tenant_id = $1 AND e.user_id = $2::bigint AND e.event = 'viewed'
             AND e.created_at >= (SELECT t FROM since))::text AS day_plan`,
      [u.tenantId, u.userId, days],
    );
    const n = (k: string) => Number(r?.[k] ?? 0);
    return { tasks: n('tasks'), protocols: n('protocols'), items: n('items'), dayPlan: n('day_plan'), mails: 0 };
  }

  /** Сколько разных дней человек уже пользовался ИИ — после трёх подсказки не нужны. */
  private async usedDays(u: AuthUser): Promise<number> {
    const r = await this.db.one<{ n: string }>(
      `SELECT count(DISTINCT date_trunc('day', created_at))::text AS n FROM ai_actions
        WHERE tenant_id = $1 AND user_id = $2::bigint AND kind IN ('nl_task', 'meeting_task')`,
      [u.tenantId, u.userId],
    );
    return Number(r?.n ?? 0);
  }
}
