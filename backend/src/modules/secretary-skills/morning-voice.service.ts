import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { localParts } from '../assistant/ping-rules';
import { tomorrowOf, zonedTime } from '../focus/close-day';
import { AiService } from '../ai/ai.service';
import { FilesService } from '../files/files.service';
import { TelegramMirror } from '../notifications/telegram-mirror.service';
import { Actor, ProactiveService } from '../proactive/proactive.service';
import { ProactiveRepository } from '../proactive/proactive.repository';
import { ProactiveScheduler } from '../proactive/proactive.scheduler';
import { WorkloadGuardService } from '../workload/workload.service';
import { BriefFacts, briefLines, speakable } from './skills-rules';

/**
 * Утренний бриф руководителя (ТЗ-21, этап 7). Приходит следом за обычной утренней
 * сводкой (ТЗ-18): 3–7 пунктов — вчера, горит сегодня, ждут решения, встречи, кто
 * перегружен, что подготовлено. С ключом OpenAI — ещё и голосом: файл в ящике
 * секретаря, в Telegram — голосовым, только если приватность push «полностью».
 * Сотрудникам — их личная сводка, как раньше (П8).
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
  ) {}

  onModuleInit(): void {
    // карточка брифа — сведения со ссылками, кнопок-действий в базе у неё нет
    this.proactive.register({ skill: 'brief', execute: async (_a: Actor, _p, action) => ({ text: action === 'done' ? 'Прочитано' : 'Готово' }) });
    this.scheduler.add('утренний бриф руководителя', () => this.tick());
  }

  /** Тем, кому сегодня уже ушла утренняя сводка, а брифа ещё нет. */
  async tick(now = new Date()): Promise<void> {
    const rows = await this.db.many<{ tenant_id: string; user_id: string; tz: string | null; last_morning: string; name: string }>(
      `SELECT sp.tenant_id::text, sp.user_id::text, COALESCE(u.timezone, t.timezone) AS tz, sp.last_morning::text, u.full_name AS name
         FROM secretary_prefs sp
         JOIN users u ON u.id = sp.user_id AND u.is_active IS NOT FALSE
         JOIN roles r ON r.id = u.role_id AND r.code IN ('owner', 'manager')
         JOIN tenants t ON t.id = sp.tenant_id
        WHERE sp.last_morning >= current_date - 1`,
    );
    for (const r of rows) {
      const tz = r.tz || 'Europe/Moscow';
      const today = localParts(now, tz).date;
      if (r.last_morning !== today) continue;
      await this.forUser(r.tenant_id, r.user_id, r.name, tz, now).catch((e) => this.log.warn(`бриф ${r.user_id}: ${(e as Error).message}`));
    }
  }

  async forUser(tenantId: string, userId: string, name: string | null, tz: string, now = new Date()): Promise<string | null> {
    const today = localParts(now, tz).date;
    const fp = `brief:${today}`;
    const done = await this.db.one(`SELECT 1 FROM assistant_proposals WHERE tenant_id = $1 AND user_id = $2 AND fingerprint = $3`, [tenantId, userId, fp]);
    if (done) return null;
    const s = await this.settings.tenantSettings(tenantId);
    if (!s.enabled) return null;
    const prefs = await this.settings.prefs(tenantId, userId);
    if (prefs.level === 'off') return null;

    const facts = await this.facts(tenantId, userId, tz, now);
    const lines = briefLines(facts);
    let audioFileId: string | null = null;
    let audio: Buffer | null = null;
    if (s.morningAudio && prefs.morningAudio) {
      audio = await this.ai.speak(tenantId, speakable(name, lines)).catch((e) => { this.log.warn(`голос: ${(e as Error).message}`); return null; });
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
      summary: lines.join('\n'),
      why: 'Сводка по команде на начало дня — чтобы не открывать пять разделов.',
      priority: 3, confidence: 1,
      actions: [{ key: 'done', label: 'Прочитано', risk: 'read', primary: true }],
      payload: {
        lines, audioFileId,
        links: [
          { label: 'Открыть Фокус', path: '/focus' },
          ...(facts.decisionsWaiting ? [{ label: 'Разобрать решения', path: '/secretary' }] : []),
          ...(facts.firstMeeting ? [{ label: 'К первой встрече', path: '/calendar' }] : []),
        ],
      },
      fingerprint: fp,
      expiresAt: zonedTime(tomorrowOf(now, tz), '00:00', tz),
    });
    if (row && audio) await this.telegram.voice(tenantId, userId, audio, 'Утренний бриф QEVO').catch(() => false);
    return row ? String(row.id) : null;
  }

  private async facts(tenantId: string, userId: string, tz: string, now: Date): Promise<BriefFacts> {
    const today = localParts(now, tz).date;
    const dayStart = zonedTime(today, '00:00', tz);
    const dayEnd = zonedTime(tomorrowOf(now, tz), '00:00', tz);
    const yStart = new Date(dayStart.getTime() - 86400_000);
    const [c, hot, waiting, meetings, first, prepared, overloaded] = await Promise.all([
      this.db.one<{ closed: number; created: number; overdue: number; due: number }>(
        `SELECT count(*) FILTER (WHERE closed_at >= $2 AND closed_at < $3)::int AS closed,
                count(*) FILTER (WHERE created_at >= $2 AND created_at < $3)::int AS created,
                count(*) FILTER (WHERE closed_at IS NULL AND deadline_at < $3)::int AS overdue,
                count(*) FILTER (WHERE closed_at IS NULL AND deadline_at >= $3 AND deadline_at < $4)::int AS due
           FROM tasks WHERE tenant_id = $1 AND deleted_at IS NULL`,
        [tenantId, yStart, dayStart, dayEnd],
      ),
      this.db.one<{ title: string; who: string | null }>(
        `SELECT t.title, u.full_name AS who FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
          WHERE t.tenant_id = $1 AND t.deleted_at IS NULL AND t.closed_at IS NULL AND t.deadline_at < $2
          ORDER BY (t.priority = 'urgent') DESC, (t.priority = 'high') DESC, t.deadline_at LIMIT 1`,
        [tenantId, dayEnd],
      ),
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
      this.db.one<{ letters: number; drafts: number; replies: number }>(
        `SELECT (SELECT count(*) FROM assistant_proposals WHERE tenant_id = $1 AND user_id = $2 AND skill = 'followup' AND status IN ('new','seen'))::int AS letters,
                (SELECT count(*) FROM meeting_task_drafts d JOIN meetings m ON m.id = d.meeting_id
                  WHERE d.tenant_id = $1 AND d.status = 'pending' AND m.created_by = $2)::int AS drafts,
                (SELECT count(*) FROM smart_reply_drafts WHERE user_id = $2 AND outcome IS NULL AND created_at > now() - interval '1 day')::int AS replies`,
        [tenantId, userId],
      ),
      this.workload.overloaded(tenantId).catch(() => [] as string[]),
    ]);
    const time = first ? localParts(new Date(first.starts_at), tz) : null;
    return {
      closedYesterday: c?.closed ?? 0, createdYesterday: c?.created ?? 0, overdue: c?.overdue ?? 0, dueToday: c?.due ?? 0,
      hottest: hot ?? null,
      decisionsWaiting: waiting?.proposals ?? 0, approvalsWaiting: waiting?.approvals ?? 0,
      meetingsToday: meetings?.n ?? 0,
      firstMeeting: first && time ? { title: first.title, time: `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}` } : null,
      prepared: { replies: prepared?.replies ?? 0, letters: prepared?.letters ?? 0, meetingDrafts: prepared?.drafts ?? 0 },
      overloaded,
    };
  }
}
