import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { runsBackground } from '../../common/process-role';
import { AppException } from '../../common/http/app-exception';
import { DbService } from '../../database/db.service';
import { zonedParts } from '../calendar/find-time';
import { DecisionQueueService } from '../decision-queue/decision-queue.service';
import { BATCH_SIZE, etaMinutes, plural, waitingTitle } from '../decision-queue/decision-queue.rules';
import { acceptDelta } from './pulse-index.rules';
import { TelegramMirror } from '../notifications/telegram-mirror.service';
import { can } from '../security/permissions';
import { SecurityService } from '../security/security.service';
import { PulseIndexService } from './pulse-index.service';
import { PulsePlusService } from './pulse-plus.service';
import { PulseRepository } from './pulse.repository';
import { dueNow, WEEKLY_DEFAULT, WeeklyPrefs, weeklyText } from './pulse-weekly.rules';

const TICK_MS = 5 * 60_000;
const base = () => (process.env.APP_BASE_URL || 'https://app.qevo.one').replace(/\/+$/, '');

/**
 * «Пульс недели» (#4890, п. 12): по понедельникам в 9:00 QEVO Bot присылает руководителю
 * индекс и изменение за неделю, главное достижение, главную пробку, 3 шага и ссылку сразу
 * в разбор решений. Только тем, у кого есть право «Пульса»; можно выключить или перенести.
 */
@Injectable()
export class PulseWeeklyService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('PulseWeekly');
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(
    private readonly db: DbService,
    private readonly security: SecurityService,
    private readonly queue: DecisionQueueService,
    private readonly index: PulseIndexService,
    private readonly plus: PulsePlusService,
    private readonly repo: PulseRepository,
    private readonly tg: TelegramMirror,
  ) {}

  onModuleInit() {
    if (!runsBackground() || process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async prefs(a: { tenantId: string; userId: string }): Promise<WeeklyPrefs> {
    const r = await this.db.one<{ enabled: boolean; weekday: number; at_time: string }>(
      `SELECT enabled, weekday, at_time FROM pulse_weekly_prefs WHERE user_id = $1 AND tenant_id = $2`, [a.userId, a.tenantId]);
    return r ? { enabled: r.enabled, weekday: Number(r.weekday), atTime: r.at_time } : { ...WEEKLY_DEFAULT };
  }

  async savePrefs(a: { tenantId: string; userId: string }, p: Partial<WeeklyPrefs>) {
    if (!can(await this.security.permissionsOf(a.tenantId, a.userId), 'radar.view')) throw AppException.forbidden('«Пульс недели» — для руководства');
    const cur = await this.prefs(a);
    const next = { ...cur, ...p };
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(next.atTime)) throw AppException.validation('Время — ЧЧ:ММ');
    if (!(next.weekday >= 0 && next.weekday <= 6)) throw AppException.validation('День недели — от 0 до 6');
    await this.db.query(
      `INSERT INTO pulse_weekly_prefs (user_id, tenant_id, enabled, weekday, at_time) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE SET enabled = $3, weekday = $4, at_time = $5, updated_at = now()`,
      [a.userId, a.tenantId, !!next.enabled, next.weekday, next.atTime]);
    return next;
  }

  /** Текст сводки — тот же, что уйдёт в Telegram (для предпросмотра в настройках). */
  async compose(a: { tenantId: string; userId: string; role: string }) {
    const [idx, w, team] = await Promise.all([
      this.index.index(a.tenantId), this.queue.waiting(a), this.db.one<{ name: string }>(`SELECT name FROM tenants WHERE id = $1`, [a.tenantId]),
    ]);
    let main: string | null = null;
    const steps: { title: string; effect: number }[] = [];
    if (w.count > 0) {
      main = `${waitingTitle(w.count)}, самая старая — ${w.oldestDays} ${plural(w.oldestDays, 'день', 'дня', 'дней')}.`;
      const take = Math.min(BATCH_SIZE, w.count);
      steps.push({ title: `Разобрать ${take} ${plural(take, 'старую проверку', 'старые проверки', 'старых проверок')} (~${etaMinutes(take)} мин)`, effect: this.index.effect(idx.points, acceptDelta(take)) });
    }
    try {
      const s = await this.plus.screen(a, null) as any;
      if (s.mode === 'full') {
        if (!main && s.main && s.main.kind !== 'none') main = `${s.main.title}. ${s.main.consequence}`;
        for (const st of s.steps.top) if (steps.length < 3) steps.push({ title: st.title, effect: st.effect });
      }
    } catch (e) { this.log.warn(`шаги для сводки: ${(e as Error).message}`); }
    const text = weeklyText({ team: team?.name ?? 'команда', score: idx.score, trend: idx.trend7, speed: idx.speed, main, steps });
    return { text, link: `${base()}/focus?review=1&src=pulse_week` };
  }

  async tick(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    let sent = 0;
    try {
      const users = await this.db.many<{ id: string; tenant_id: string; role: string; tz: string | null }>(
        `SELECT u.id::text, u.tenant_id::text, r.code AS role, COALESCE(u.timezone, t.timezone) AS tz
           FROM users u JOIN roles r ON r.id = u.role_id JOIN tenants t ON t.id = u.tenant_id
          WHERE u.is_active AND r.code <> 'client' AND u.last_seen_at > now() - interval '30 days'
            AND EXISTS (SELECT 1 FROM telegram_accounts ta WHERE ta.tenant_id = u.tenant_id AND ta.user_id = u.id)`);
      for (const u of users) {
        try {
          const a = { tenantId: u.tenant_id, userId: u.id, role: u.role };
          const p = await this.prefs(a);
          const local = zonedParts(Date.now(), u.tz || 'Europe/Moscow');
          if (!dueNow(p, { weekday: local.weekday, minutes: local.hh * 60 + local.mm })) continue;
          // только руководителю: право «Пульса», как на экране
          if (!can(await this.security.permissionsOf(a.tenantId, a.userId), 'radar.view')) continue;
          const claimed = await this.db.one<{ k: string }>(
            `INSERT INTO pulse_weekly_sends (user_id, week_key) VALUES ($1, $2::date) ON CONFLICT DO NOTHING RETURNING user_id::text AS k`, [u.id, local.date]);
          if (!claimed) continue;
          const { text, link } = await this.compose(a);
          await this.tg.pushButtons(a.tenantId, a.userId, text, [[{ text: 'Открыть разбор в Qevo →', url: link }]]);
          await this.repo.event(a.tenantId, a.userId, 'weekly_sent', local.date);
          sent++;
        } catch (e) { this.log.warn(`пульс недели ${u.id}: ${(e as Error).message}`); }
      }
    } catch (e) {
      this.log.warn(`пульс недели: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
    return sent;
  }
}
