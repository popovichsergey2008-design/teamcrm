import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { meetingVisibleSql } from '../../common/access/project-visibility';
import { localParts } from '../assistant/ping-rules';
import { tomorrowOf, zonedTime } from '../focus/close-day';
import { AiService } from '../ai/ai.service';
import { FilesService } from '../files/files.service';
import { TelegramMirror } from '../notifications/telegram-mirror.service';
import { Actor, ProactiveService } from '../proactive/proactive.service';
import { ProactiveRepository, ProposalRow } from '../proactive/proactive.repository';
import { ProactiveScheduler } from '../proactive/proactive.scheduler';
import { WorkloadGuardService } from '../workload/workload.service';
import { assigneeOwesSql } from '../tasks/responsibility';
import { StandupService } from '../focus-brief/standup.service';
import { briefDue, CoffeeFacts, morningCoffee, StandupDraft, standupDrafts, StandupInput } from './morning-rules';

const DEFAULT_AT = '09:00';

/**
 * Утренний аудио-кофе руководителя (ТЗ-21, этап 7; #1525 — слово в слово по документу).
 *
 * В 9:00 по поясу человека (своё время или «выключено» — в настройках секретаря)
 * владельцу и руководителям: «Доброе утро, Борис! На связи ваш ассистент QEVO. Вот
 * главное на сегодня: …» — вчерашние решения созвонов, горящие дедлайны команды,
 * служба заботы — и черновики утренней планерки в той же карточке, каждый — задача в
 * 1 клик. С ключом ИИ — голосом: плеер в карточке, в Telegram — голосовое (при
 * приватности push «полностью»). Сотрудникам — их личная сводка, как раньше (П8).
 */
@Injectable()
export class MorningVoiceService implements OnModuleInit {
  private readonly log = new Logger('MorningVoice');

  constructor(
    private readonly db: DbService,
    private readonly ai: AiService,
    private readonly files: FilesService,
    private readonly telegram: TelegramMirror,
    private readonly proactive: ProactiveService,
    private readonly settings: ProactiveRepository,
    private readonly scheduler: ProactiveScheduler,
    private readonly workload: WorkloadGuardService,
    private readonly standup: StandupService,
  ) {}

  onModuleInit(): void {
    // «Прочитано» — сведения; «Поставить задачей» — черновик планерки становится задачей
    this.proactive.register({
      skill: 'brief',
      execute: async (a: Actor, p: ProposalRow, action, params) => (action === 'task'
        ? this.standup.execute(a, p, params ?? {})
        : { text: action === 'done' ? 'Прочитано' : 'Готово' }),
    });
    this.scheduler.add('утренний бриф руководителя', () => this.tick());
  }

  /**
   * Владельцы и руководители, у кого подошло время брифа. Строки настроек может не быть
   * вовсе — тогда 9:00 (документ: «без всякой настройки»); NULL в brief_at — выключил.
   */
  async tick(now = new Date()): Promise<void> {
    const rows = await this.db.many<{ tenant_id: string; user_id: string; tz: string | null; name: string; brief_at: string; weekdays_only: boolean }>(
      `SELECT u.tenant_id::text, u.id::text AS user_id, COALESCE(u.timezone, t.timezone) AS tz, u.full_name AS name,
              CASE WHEN sp.user_id IS NULL THEN '${DEFAULT_AT}' ELSE to_char(sp.brief_at, 'HH24:MI') END AS brief_at,
              COALESCE(sp.weekdays_only, TRUE) AS weekdays_only
         FROM users u
         JOIN roles r ON r.id = u.role_id AND r.code IN ('owner', 'manager')
         JOIN tenants t ON t.id = u.tenant_id
    LEFT JOIN secretary_prefs sp ON sp.user_id = u.id
        WHERE u.is_active IS NOT FALSE AND (sp.user_id IS NULL OR sp.brief_at IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM secretary_sent x WHERE x.user_id = u.id AND x.kind = 'morning_coffee'
                             AND x.ref >= to_char(current_date - 1, 'YYYY-MM-DD'))`,
    );
    for (const r of rows) {
      const tz = r.tz || 'Europe/Moscow';
      const l = localParts(now, tz);
      if (!briefDue(r.brief_at, { hour: l.hour, minute: l.minute, dow: l.dow }, r.weekdays_only)) continue;
      await this.forUser(r.tenant_id, r.user_id, r.name, tz, now).catch((e) => this.log.warn(`бриф ${r.user_id}: ${(e as Error).message}`));
    }
  }

  async forUser(tenantId: string, userId: string, name: string | null, tz: string, now = new Date()): Promise<string | null> {
    const today = localParts(now, tz).date;
    const fp = `brief:${today}`;
    const done = await this.db.one(`SELECT 1 FROM assistant_proposals WHERE tenant_id = $1 AND user_id = $2 AND fingerprint = $3`, [tenantId, userId, fp]);
    if (done) return null;
    const s = await this.settings.tenantSettings(tenantId);
    if (!s.enabled || !s.morningAudio) return null;
    const prefs = await this.settings.prefs(tenantId, userId);
    if (prefs.level === 'off') return null;
    // один бриф на день даже при двух экземплярах во время выкладки: синтез — один раз
    const claimed = await this.db.query(
      `INSERT INTO secretary_sent (user_id, kind, ref) VALUES ($1, 'morning_coffee', $2) ON CONFLICT DO NOTHING`, [userId, today],
    );
    if (!claimed.rowCount) return null;
    try {
      return await this.compose(tenantId, userId, name, tz, now, today, fp, prefs.morningAudio);
    } catch (e) {
      // не получилось — освобождаем день: следующий тик попробует снова
      await this.db.query(`DELETE FROM secretary_sent WHERE user_id = $1 AND kind = 'morning_coffee' AND ref = $2`, [userId, today]).catch(() => undefined);
      throw e;
    }
  }

  private async compose(tenantId: string, userId: string, name: string | null, tz: string, now: Date, today: string, fp: string, voice: boolean) {
    const { facts, standup, firstMeeting } = await this.facts(tenantId, userId, tz, now);
    const drafts: StandupDraft[] = standupDrafts(standup);
    const coffee = morningCoffee({ ...facts, name, drafts: drafts.length });

    let audioFileId: string | null = null;
    let audio: Buffer | null = null;
    if (voice && (await this.settings.withinDailyLimit(tenantId, 'morning_voice'))) {
      audio = await this.ai.speak(tenantId, coffee.speech).catch((e) => { this.log.warn(`голос: ${(e as Error).message}`); return null; });
      if (audio) {
        const f = await this.files.upload({
          tenantId, userId, buffer: audio, fileName: `brief-${today}.mp3`, contentType: 'audio/mpeg', ownerKind: 'assistant_brief',
        }).catch(() => null);
        audioFileId = f ? String(f.id) : null;
      }
    }
    const row = await this.proactive.propose({
      tenantId, userId, skill: 'brief', kind: 'morning', sourceType: 'brief', sourceId: today, sourceAt: now,
      sourceLabel: 'Утренний бриф', sourceLink: '/focus',
      title: 'Утро: главное на сегодня',
      summary: [coffee.intro, ...coffee.items, coffee.outro].join('\n'),
      why: 'Сводка по команде на начало дня — чтобы не открывать пять разделов.',
      recommend: drafts.length ? 'Поставьте задачей то, что берёте на планерку, — в 1 клик.' : '',
      effect: drafts.length ? 'Задача появится на вас в проекте пункта, со сроком сегодня к 18:00.' : '',
      priority: 3, confidence: 1,
      actions: [
        { key: 'done', label: 'Прочитано', risk: 'read', primary: true },
        ...(drafts.length ? [{ key: 'task', label: 'Поставить задачей', risk: 'low_write' }] : []),
      ],
      payload: {
        intro: coffee.intro, lines: coffee.items, outro: coffee.outro, audioFileId, drafts,
        links: [
          { label: 'Открыть Фокус', path: '/focus' },
          ...(facts.waiting.proposals ? [{ label: 'Разобрать решения', path: '/secretary' }] : []),
          ...(firstMeeting ? [{ label: 'К первой встрече', path: '/calendar' }] : []),
        ],
      },
      fingerprint: fp,
      expiresAt: zonedTime(tomorrowOf(now, tz), '00:00', tz),
    });
    if (row && audio) await this.telegram.voice(tenantId, userId, audio, 'Утренний бриф QEVO').catch(() => false);
    return row ? String(row.id) : null;
  }

  /**
   * Факты брифа. Руководитель видит все проекты; встречи — по общему правилу видимости
   * (созвон из чужого личного чата ему не виден). Служба заботы — обращения своей
   * организации за вчера; у вендора (организации-платформы) — все обращения.
   */
  private async facts(tenantId: string, userId: string, tz: string, now: Date): Promise<{
    facts: Omit<CoffeeFacts, 'name' | 'drafts'>; standup: StandupInput; firstMeeting: { title: string; time: string } | null;
  }> {
    const today = localParts(now, tz).date;
    const dayStart = zonedTime(today, '00:00', tz);
    const dayEnd = zonedTime(tomorrowOf(now, tz), '00:00', tz);
    const yStart = new Date(dayStart.getTime() - 86400_000);
    const OPEN = `t.tenant_id = $1 AND t.deleted_at IS NULL AND t.closed_at IS NULL
      AND EXISTS (SELECT 1 FROM projects p WHERE p.id = t.project_id AND p.status <> 'archived')`;
    const [decisions, hot, hotCount, overdue, overdueCount, blocked, support, waiting, meetings, first, overloaded] = await Promise.all([
      this.db.many<{ id: string; text: string; project_id: string | null; meeting_id: string; title: string | null; peer: string | null }>(
        `SELECT d.id::text, d.text, COALESCE(d.project_id, m.project_id)::text AS project_id, m.id::text AS meeting_id, m.title,
                COALESCE(
                  (SELECT u.full_name FROM meeting_segments s JOIN users u ON u.id = s.speaker_user_id
                    WHERE s.meeting_id = m.id AND s.speaker_user_id <> $2::bigint
                    GROUP BY u.id, u.full_name ORDER BY count(*) DESC LIMIT 1),
                  (SELECT u.full_name FROM users u WHERE u.id = m.created_by AND u.id <> $2::bigint)) AS peer
           FROM decisions d JOIN meetings m ON m.id = d.meeting_id
          WHERE d.tenant_id = $1 AND d.revoked_at IS NULL AND d.superseded_at IS NULL
            AND COALESCE(m.happened_at, m.created_at) >= $3 AND COALESCE(m.happened_at, m.created_at) < $4
            AND ${meetingVisibleSql('m', { user: '$2', all: 'TRUE', client: 'FALSE' })}
          ORDER BY d.id LIMIT 4`,
        [tenantId, userId, yStart, dayStart],
      ),
      // горит сегодня — только то, что сейчас у исполнителя (ТЗ-30)
      this.db.many<{ id: string; project_id: string; title: string; who: string | null }>(
        `SELECT t.id::text, t.project_id::text, t.title, u.full_name AS who FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
          WHERE ${OPEN} AND ${assigneeOwesSql('t')} AND t.deadline_at >= $2 AND t.deadline_at < $3
          ORDER BY (t.priority = 'urgent') DESC, (t.priority = 'high') DESC, t.deadline_at LIMIT 4`,
        [tenantId, dayStart, dayEnd],
      ),
      this.db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM tasks t WHERE ${OPEN} AND ${assigneeOwesSql('t')} AND t.deadline_at >= $2 AND t.deadline_at < $3`,
        [tenantId, dayStart, dayEnd],
      ),
      this.db.many<{ id: string; project_id: string; title: string; who: string | null }>(
        `SELECT t.id::text, t.project_id::text, t.title, u.full_name AS who FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
          WHERE ${OPEN} AND ${assigneeOwesSql('t')} AND t.deadline_at < $2
          ORDER BY (t.priority = 'urgent') DESC, (t.priority = 'high') DESC, t.deadline_at DESC LIMIT 4`,
        [tenantId, dayStart],
      ),
      this.db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM tasks t WHERE ${OPEN} AND ${assigneeOwesSql('t')} AND t.deadline_at < $2`,
        [tenantId, dayStart],
      ),
      this.db.many<{ id: string; project_id: string; title: string; who: string | null }>(
        `SELECT t.id::text, t.project_id::text, t.title, u.full_name AS who FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
          WHERE ${OPEN} AND t.is_blocked ORDER BY t.updated_at DESC LIMIT 2`,
        [tenantId],
      ),
      this.db.one<{ total: number; closed: number }>(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE c.status IN ('resolved', 'closed'))::int AS closed
           FROM support_conversations c
          WHERE (c.tenant_id = $1 OR EXISTS (SELECT 1 FROM tenants pt WHERE pt.id = $1 AND pt.is_platform))
            AND c.created_at >= $2 AND c.created_at < $3`,
        [tenantId, yStart, dayStart],
      ).catch(() => null),
      this.db.one<{ proposals: number; approvals: number }>(
        `SELECT (SELECT count(*) FROM assistant_proposals WHERE tenant_id = $1 AND user_id = $2 AND status IN ('new','seen') AND skill <> 'brief')::int AS proposals,
                (SELECT count(*) FROM approvals WHERE tenant_id = $1 AND approver_id = $2 AND status = 'pending')::int AS approvals`,
        [tenantId, userId],
      ),
      this.db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM calendar_events e JOIN calendar_participants p ON p.event_id = e.id AND p.user_id = $2
          WHERE e.tenant_id = $1 AND e.starts_at >= $3 AND e.starts_at < $4 AND p.status <> 'declined'`,
        [tenantId, userId, dayStart, dayEnd],
      ),
      this.db.one<{ title: string; starts_at: Date }>(
        `SELECT e.title, e.starts_at FROM calendar_events e JOIN calendar_participants p ON p.event_id = e.id AND p.user_id = $2
          WHERE e.tenant_id = $1 AND e.starts_at >= $3 AND e.starts_at < $4 AND p.status <> 'declined' ORDER BY e.starts_at LIMIT 1`,
        [tenantId, userId, now, dayEnd],
      ),
      this.workload.overloaded(tenantId).catch(() => [] as string[]),
    ]);
    const time = first ? localParts(new Date(first.starts_at), tz) : null;
    const firstMeeting = first && time ? { title: first.title, time: `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}` } : null;
    return {
      facts: {
        decisions: decisions.map((d) => ({ text: d.text, peer: d.peer, meetingTitle: d.title })),
        hot: hot.map((h) => ({ title: h.title, who: h.who })),
        hotTotal: hotCount?.n ?? hot.length,
        overdue: overdueCount?.n ?? 0,
        support: support && support.total ? { total: support.total, closed: support.closed } : null,
        waiting: { proposals: waiting?.proposals ?? 0, approvals: waiting?.approvals ?? 0 },
        meetingsToday: meetings?.n ?? 0,
        firstMeeting,
        overloaded,
      },
      standup: {
        tasks: [
          ...overdue.map((t) => ({ id: t.id, projectId: t.project_id, title: t.title, who: t.who, overdue: true })),
          ...hot.map((t) => ({ id: t.id, projectId: t.project_id, title: t.title, who: t.who, overdue: false })),
        ],
        blocked: blocked.map((t) => ({ id: t.id, projectId: t.project_id, title: t.title, who: t.who })),
        decisions: decisions.map((d) => ({ id: d.id, projectId: d.project_id, text: d.text, meetingId: d.meeting_id, meetingTitle: d.title })),
      },
      firstMeeting,
    };
  }
}
