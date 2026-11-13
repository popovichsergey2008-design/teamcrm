import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { setFocusTelegram } from '../../common/focus-telegram-hook';
import { DbService } from '../../database/db.service';
import { zonedParts, zonedToUtc } from '../calendar/find-time';
import { CalendarPlusService } from '../calendar-plus/calendar-plus.service';
import { FocusDayService } from '../focus/focus-day.service';
import { PushService } from '../notifications/push.service';
import { TelegramMirror } from '../notifications/telegram-mirror.service';
import { hours, shortTitle } from './day-plan';
import { FocusPlusService } from './focus-plus.service';
import { compareMinutes, hourRange, peakHour, softStreak } from './habit-rules';

type Viewer = { tenantId: string; userId: string; role: string };
const MIN = 60_000;
const DAY = 86_400_000;
const CHANNELS = ['telegram', 'email', 'push'] as const;
type Channel = typeof CHANNELS[number];
export interface HabitPrefs { planOn: boolean; planAt: string | null; channels: Channel[]; weekOn: boolean }

const base = () => (process.env.APP_BASE_URL || 'https://app.qevo.one').replace(/\/+$/, '');
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/**
 * «Фокус дня» #4891, волна 3 (п. 12): план в начале рабочего дня в Telegram / почту / пуш
 * с «✓ Принять» и «Открыть в Qevo», итоги недели в пятницу, мягкая серия дней с планом.
 * Время и каналы — в настройках, всё выключается. Принятый в Telegram план сразу виден
 * принятым в приложении: принимаем тем же путём, что и кнопка на экране.
 */
@Injectable()
export class FocusHabitService implements OnModuleInit {
  private readonly log = new Logger('FocusHabit');

  constructor(
    private readonly db: DbService,
    private readonly plus: FocusPlusService,
    private readonly focus: FocusDayService,
    private readonly cal: CalendarPlusService,
    private readonly push: PushService,
    private readonly tg: TelegramMirror,
  ) {}

  onModuleInit() {
    setFocusTelegram((tenantId, userId, data) => this.onButton(tenantId, userId, data));
  }

  // ---------- настройки ----------

  async prefs(v: Viewer): Promise<HabitPrefs> {
    const r = await this.db.one<{ plan_on: boolean; plan_at: string | null; channels: string[]; week_on: boolean }>(
      `SELECT plan_on, plan_at, channels, week_on FROM focus_habit_prefs WHERE user_id = $1`, [v.userId]);
    return r
      ? { planOn: r.plan_on, planAt: r.plan_at, channels: r.channels.filter((c): c is Channel => (CHANNELS as readonly string[]).includes(c)), weekOn: r.week_on }
      : { planOn: true, planAt: null, channels: ['telegram', 'push'], weekOn: true };
  }

  async savePrefs(v: Viewer, dto: Partial<HabitPrefs>) {
    const cur = await this.prefs(v);
    const next: HabitPrefs = {
      planOn: dto.planOn ?? cur.planOn,
      planAt: dto.planAt === undefined ? cur.planAt : dto.planAt && /^\d{2}:\d{2}$/.test(dto.planAt) ? dto.planAt : null,
      channels: dto.channels ? [...new Set(dto.channels.filter((c) => (CHANNELS as readonly string[]).includes(c)))] : cur.channels,
      weekOn: dto.weekOn ?? cur.weekOn,
    };
    await this.db.query(
      `INSERT INTO focus_habit_prefs (user_id, tenant_id, plan_on, plan_at, channels, week_on) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE SET plan_on = $3, plan_at = $4, channels = $5, week_on = $6, updated_at = now()`,
      [v.userId, v.tenantId, next.planOn, next.planAt, next.channels, next.weekOn]);
    return next;
  }

  // ---------- серия ----------

  /** Дней с принятым планом подряд: выходные и отпуск не считаются, один пропуск прощается. */
  async streak(v: Viewer) {
    const prefs = await this.cal.prefs(v.tenantId, v.userId);
    const today = zonedParts(Date.now(), prefs.timeZone).date;
    const from = new Date(Date.parse(`${today}T12:00:00Z`) - 120 * DAY).toISOString().slice(0, 10);
    const [plans, off] = await Promise.all([
      this.db.many<{ d: string }>(
        `SELECT to_char(focus_date, 'YYYY-MM-DD') AS d FROM focus_day_plans
          WHERE user_id = $1 AND focus_date BETWEEN $2::date AND $3::date AND status <> 'proposed'`, [v.userId, from, today]),
      this.db.many<{ f: string; t: string }>(
        `SELECT to_char(from_date, 'YYYY-MM-DD') AS f, to_char(to_date, 'YYYY-MM-DD') AS t FROM user_availability
          WHERE tenant_id = $1 AND user_id = $2 AND kind IN ('vacation', 'sick') AND to_date >= $3::date`, [v.tenantId, v.userId, from]),
    ]);
    const planned = new Set(plans.map((p) => p.d));
    const days = [];
    for (let i = 0; i <= 120; i++) {
      const dt = new Date(Date.parse(`${today}T12:00:00Z`) - i * DAY);
      const date = dt.toISOString().slice(0, 10);
      const weekend = prefs.company.weekendDays.includes(dt.getUTCDay());
      days.push({ date, planned: planned.has(date), off: !planned.has(date) && (weekend || off.some((o) => date >= o.f && date <= o.t)) });
    }
    return { days: softStreak(days) };
  }

  // ---------- план утром ----------

  /** Текст плана: бриф, тройка со временем, ёмкость. Один источник с экраном — plus.day. */
  private async planText(v: Viewer) {
    const d = await this.plus.day(v);
    if (!d.enabled || d.dayOff) return null;
    const tasks = d.timeline.filter((s) => s.kind === 'task').map((s) => `${new Date(s.startsAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: d.timeZone })} — ${s.title}`);
    const lines = [
      '☀️ План на сегодня',
      d.brief.yesterday ?? '',
      d.brief.text,
      ...tasks.map((t) => `• ${t}`),
      d.capacity.overloadMin > 0 ? `⚠️ День перегружен на ${hours(d.capacity.overloadMin)} — перенести можно в Qevo.` : `Резерв: ${hours(d.capacity.reserveMin)}.`,
    ].filter(Boolean);
    return { text: lines.join('\n'), date: d.date, accepted: d.phase !== 'morning', overload: d.capacity.overloadMin > 0 };
  }

  /** Раз в 5 минут: кому пора (своё время или начало рабочего дня, окно 60 мин) — план по каналам. */
  async sendMorning(): Promise<number> {
    const users = await this.candidates();
    let sent = 0;
    for (const u of users) {
      const v = { tenantId: u.tenant_id, userId: u.id, role: u.role };
      try {
        const hp = await this.prefs(v);
        if (!hp.planOn || !hp.channels.length) continue;
        const prefs = await this.cal.prefs(v.tenantId, v.userId);
        const now = zonedParts(Date.now(), prefs.timeZone);
        if (prefs.company.weekendDays.includes(now.weekday)) continue;
        const [y, m, d] = now.date.split('-').map(Number);
        const [h, mi] = (hp.planAt ?? prefs.workStart ?? '09:00').split(':').map(Number);
        const at = zonedToUtc(y, m, d, h || 9, mi || 0, prefs.timeZone);
        if (Date.now() < at || Date.now() > at + 60 * MIN) continue;
        if (!(await this.claim(v.userId, 'plan', now.date))) continue;
        const plan = await this.planText(v);
        if (!plan || plan.accepted) continue;
        await this.deliver(v, hp.channels, 'focus.plan', 'План на сегодня', plan.text, '/focus',
          [[{ text: '✓ Принять', callback_data: `f:acc:${plan.date}` }, { text: 'Открыть в Qevo', url: `${base()}/focus` }]]);
        sent++;
      } catch (e) { this.log.warn(`план утром ${u.id}: ${(e as Error).message}`); }
    }
    return sent;
  }

  /** Пятница, за час до конца рабочего дня (окно 2 ч) — итоги недели. */
  async sendWeekly(): Promise<number> {
    const users = await this.candidates();
    let sent = 0;
    for (const u of users) {
      const v = { tenantId: u.tenant_id, userId: u.id, role: u.role };
      try {
        const hp = await this.prefs(v);
        if (!hp.weekOn || !hp.channels.length) continue;
        const prefs = await this.cal.prefs(v.tenantId, v.userId);
        const now = zonedParts(Date.now(), prefs.timeZone);
        if (now.weekday !== 5) continue;
        const [y, m, d] = now.date.split('-').map(Number);
        const [h, mi] = (prefs.workEnd ?? '18:00').split(':').map(Number);
        const at = zonedToUtc(y, m, d, h || 18, mi || 0, prefs.timeZone) - 60 * MIN;
        if (Date.now() < at || Date.now() > at + 120 * MIN) continue;
        const w = await this.week(v);
        if (!w.deepMin && !w.results.length) continue;
        if (!(await this.claim(v.userId, 'week', now.date))) continue;
        await this.deliver(v, hp.channels, 'focus.week', 'Итоги недели', w.text, '/focus?week=1',
          [[{ text: 'Открыть в Qevo', url: `${base()}/focus?week=1` }]]);
        sent++;
      } catch (e) { this.log.warn(`итоги недели ${u.id}: ${(e as Error).message}`); }
    }
    return sent;
  }

  private candidates() {
    return this.db.many<{ id: string; tenant_id: string; role: string }>(
      `SELECT u.id::text, u.tenant_id::text, r.code AS role FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.is_active AND r.code IN ('owner', 'manager', 'member') AND u.last_seen_at > now() - interval '14 days'`);
  }

  private async claim(userId: string, kind: 'plan' | 'week', key: string) {
    return !!(await this.db.one<{ k: string }>(
      `INSERT INTO focus_habit_sends (user_id, kind, key) VALUES ($1, $2, $3::date) ON CONFLICT DO NOTHING RETURNING kind AS k`, [userId, kind, key]));
  }

  private async deliver(v: Viewer, channels: Channel[], eventKey: string, title: string, text: string, path: string, keyboard: unknown[][]) {
    if (channels.includes('telegram')) await this.tg.pushButtons(v.tenantId, v.userId, text, keyboard);
    if (channels.includes('push')) {
      await this.push.personal({ tenantId: v.tenantId, userId: v.userId, eventKey, title, body: text.split('\n').slice(1, 3).join(' ').slice(0, 300), path });
    }
    if (channels.includes('email')) {
      const u = await this.db.one<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [v.userId]);
      if (u?.email) {
        const html = `${text.split('\n').map((l) => `<p>${esc(l)}</p>`).join('')}<p><a href="${base()}${path}">Открыть в Qevo</a></p>`;
        await this.db.query(
          `INSERT INTO mail_outbox (tenant_id, user_id, to_email, subject, body_text, body_html, event_key, dedup_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (dedup_key) DO NOTHING`,
          [v.tenantId, v.userId, u.email, title, `${text}\n\n${base()}${path}`, html, eventKey, `${eventKey}:${v.userId}:${new Date().toISOString().slice(0, 10)}`]);
      }
    }
  }

  /** «✓ Принять» из Telegram: тот же путь, что и кнопка на экране; перегруз — только в Qevo. */
  async onButton(tenantId: string, userId: string, data: string): Promise<string> {
    const m = /^f:acc:(\d{4}-\d{2}-\d{2})$/.exec(data);
    if (!m) return 'Кнопка устарела — откройте QEVO.';
    const role = (await this.db.one<{ code: string }>(`SELECT r.code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1 AND u.tenant_id = $2`, [userId, tenantId]))?.code ?? 'member';
    const v = { tenantId, userId, role };
    const d = await this.plus.day(v);
    if (!d.enabled) return 'Фокус дня выключен.';
    if (d.date !== m[1]) return 'Это план за другой день — свежий план в QEVO.';
    if (d.phase !== 'morning') return '✓ План уже принят.';
    if (d.capacity.overloadMin > 0) return `День перегружен на ${hours(d.capacity.overloadMin)}. Откройте QEVO — там можно перенести задачу или всё равно оставить: ${base()}/focus`;
    await this.plus.accept(v);
    return '✓ План принят — в QEVO он уже отмечен принятым.';
  }

  // ---------- итоги недели ----------

  /** Часы глубокой работы, главные результаты, сравнение с прошлой неделей, лучшее время, прерывания. */
  async week(v: Viewer) {
    const prefs = await this.cal.prefs(v.tenantId, v.userId);
    const tz = prefs.timeZone;
    const now = zonedParts(Date.now(), tz);
    const back = (now.weekday + 6) % 7; // от понедельника
    const [y, m, d] = now.date.split('-').map(Number);
    const monday = zonedToUtc(y, m, d, 0, 0, tz) - back * DAY;
    const prevMonday = monday - 7 * DAY;
    const deep = await this.db.many<{ wk: string; min: number }>(
      `SELECT CASE WHEN s.started_at >= $3 THEN 'now' ELSE 'prev' END AS wk,
              COALESCE(SUM(LEAST(s.planned_minutes, EXTRACT(EPOCH FROM (COALESCE(s.ended_at, now()) - s.started_at)) / 60)), 0)::int AS min
         FROM focus_sessions s
        WHERE s.tenant_id = $1 AND s.user_id = $2 AND s.status IN ('completed', 'running', 'paused') AND s.started_at >= $4
        GROUP BY 1`, [v.tenantId, v.userId, new Date(monday), new Date(prevMonday)]);
    const deepMin = deep.find((r) => r.wk === 'now')?.min ?? 0;
    const prevMin = deep.find((r) => r.wk === 'prev')?.min ?? 0;
    const results = await this.db.many<{ title: string }>(
      `SELECT DISTINCT ON (i.task_id) i.title_snapshot AS title FROM focus_day_items i JOIN focus_day_plans p ON p.id = i.plan_id
        WHERE p.tenant_id = $1 AND p.user_id = $2 AND i.status = 'done' AND i.item_type = 'task' AND p.focus_date >= $3::date
        ORDER BY i.task_id, i.updated_at DESC LIMIT 5`, [v.tenantId, v.userId, new Date(monday + 12 * 3_600_000).toISOString().slice(0, 10)]);
    const byHour = async (sql: string) => Object.fromEntries((await this.db.many<{ h: number; n: number }>(sql, [v.tenantId, v.userId, new Date(monday - 21 * DAY), tz])).map((r) => [r.h, r.n]));
    const focusHours = await byHour(
      `SELECT EXTRACT(HOUR FROM s.started_at AT TIME ZONE $4)::int AS h,
              SUM(LEAST(s.planned_minutes, EXTRACT(EPOCH FROM (COALESCE(s.ended_at, now()) - s.started_at)) / 60))::int AS n
         FROM focus_sessions s WHERE s.tenant_id = $1 AND s.user_id = $2 AND s.status = 'completed' AND s.started_at >= $3 GROUP BY 1`);
    const interrupts = await byHour(
      `SELECT EXTRACT(HOUR FROM m.created_at AT TIME ZONE $4)::int AS h, count(*)::int AS n
         FROM chat_messages m JOIN chats c ON c.id = m.chat_id AND c.kind = 'dm'
         JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $2
        WHERE m.tenant_id = $1 AND m.author_id <> $2 AND m.created_at >= $3 GROUP BY 1`);
    const best = peakHour(focusHours);
    const noisy = peakHour(interrupts);
    const streak = (await this.streak(v)).days;
    const lines = [
      '📊 Итоги недели',
      `Глубокая работа: ${hours(deepMin)} (${compareMinutes(deepMin, prevMin, hours)}).`,
      results.length ? `Главные результаты: ${results.map((r) => `«${shortTitle(r.title, 50)}»`).join(', ')}.` : 'Главных результатов в Фокусе на этой неделе не отмечено.',
      best !== null ? `Лучшее время для фокуса: ${hourRange(best)}.` : '',
      noisy !== null ? `Больше всего прерываний: ${hourRange(noisy)}.` : '',
      streak > 1 ? `Дней с планом подряд: ${streak}.` : '',
    ].filter(Boolean);
    return {
      deepMin, prevMin, compare: compareMinutes(deepMin, prevMin, hours),
      results: results.map((r) => shortTitle(r.title, 60)),
      bestTime: best !== null ? hourRange(best) : null, interruptions: noisy !== null ? hourRange(noisy) : null,
      streak, text: lines.join('\n'),
    };
  }
}
