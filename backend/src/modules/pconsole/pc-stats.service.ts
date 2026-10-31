import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { effective, SubRow } from '../billing/billing-rules';
import { estimateCost } from '../ai/usage-catalog';
import { deltaPct, Period } from './pc-rules';

/**
 * Активность v1 (§5.2): человек что-то сделал сам — написал в чат или в задачу, поставил
 * задачу. Вход, «в сети» и автообновление не считаются. Список версионируется: меняем
 * правило — меняем номер, чтобы старые цифры не сравнивали с новыми молча.
 */
export const ACTIVITY_VERSION = 'v1: сообщение в чате, комментарий к задаче, новая задача';

/** Настоящие компании: без тестовых и без площадки вендора (§5.2). */
const REAL = `SELECT id, created_at FROM tenants WHERE NOT is_test AND NOT is_platform`;

interface Counts {
  users_new: number; users_total: number; verified_new: number; companies_new: number; companies_total: number;
  joined_invite: number; active_users: number; revenue_rub: number; payments: number; new_paying: number;
  support_new: number; installs_new: number; installs_active: number;
}

/**
 * Сводки для консоли владельца. Только агрегаты: ни текста сообщений, ни задач,
 * ни имён сотрудников компаний — консоль считает, а не читает.
 */
@Injectable()
export class PcStatsService {
  constructor(private readonly db: DbService) {}

  private async counts(from: string, to: string, tz: string): Promise<Counts> {
    const r = await this.db.one<Counts>(
      `WITH b AS (SELECT ($1::date)::timestamp AT TIME ZONE $3::text AS lo, ($2::date)::timestamp AT TIME ZONE $3::text AS hi),
            rt AS (${REAL}),
            ra AS (SELECT DISTINCT u.account_id AS id FROM users u JOIN rt ON rt.id=u.tenant_id WHERE u.account_id IS NOT NULL)
       SELECT
         (SELECT count(*) FROM accounts a JOIN ra ON ra.id=a.id, b WHERE a.created_at >= b.lo AND a.created_at < b.hi)::int AS users_new,
         (SELECT count(*) FROM accounts a JOIN ra ON ra.id=a.id, b WHERE a.created_at < b.hi)::int AS users_total,
         (SELECT count(*) FROM accounts a JOIN ra ON ra.id=a.id, b WHERE a.email_verified_at >= b.lo AND a.email_verified_at < b.hi)::int AS verified_new,
         (SELECT count(*) FROM rt, b WHERE rt.created_at >= b.lo AND rt.created_at < b.hi)::int AS companies_new,
         (SELECT count(*) FROM rt, b WHERE rt.created_at < b.hi)::int AS companies_total,
         (SELECT count(*) FROM invites i JOIN rt ON rt.id=i.tenant_id, b WHERE i.accepted_at >= b.lo AND i.accepted_at < b.hi)::int AS joined_invite,
         (SELECT count(DISTINCT x.uid) FROM (
             SELECT m.author_id AS uid FROM chat_messages m JOIN rt ON rt.id=m.tenant_id, b
              WHERE m.created_at >= b.lo AND m.created_at < b.hi AND NOT m.is_ai
             UNION ALL
             SELECT c.author_id FROM task_comments c JOIN rt ON rt.id=c.tenant_id, b
              WHERE c.created_at >= b.lo AND c.created_at < b.hi AND NOT c.is_ai
             UNION ALL
             SELECT k.created_by FROM tasks k JOIN rt ON rt.id=k.tenant_id, b
              WHERE k.created_at >= b.lo AND k.created_at < b.hi
           ) x WHERE x.uid IS NOT NULL)::int AS active_users,
         (SELECT coalesce(sum(p.amount_rub), 0) FROM billing_payments p JOIN rt ON rt.id=p.tenant_id, b
           WHERE p.status='succeeded' AND p.paid_at >= b.lo AND p.paid_at < b.hi)::float8 AS revenue_rub,
         (SELECT count(*) FROM billing_payments p JOIN rt ON rt.id=p.tenant_id, b
           WHERE p.status='succeeded' AND p.paid_at >= b.lo AND p.paid_at < b.hi)::int AS payments,
         (SELECT count(*) FROM (SELECT tenant_id, min(paid_at) AS first FROM billing_payments WHERE status='succeeded' GROUP BY tenant_id) f
            JOIN rt ON rt.id=f.tenant_id, b WHERE f.first >= b.lo AND f.first < b.hi)::int AS new_paying,
         (SELECT count(*) FROM support_conversations s JOIN rt ON rt.id=s.tenant_id, b WHERE s.created_at >= b.lo AND s.created_at < b.hi)::int AS support_new,
         (SELECT count(*) FROM mobile_devices d JOIN rt ON rt.id=d.tenant_id, b WHERE d.created_at >= b.lo AND d.created_at < b.hi)::int AS installs_new,
         (SELECT count(DISTINCT d.device_uuid) FROM mobile_devices d JOIN rt ON rt.id=d.tenant_id, b
           WHERE d.last_seen_at >= b.lo AND d.last_seen_at < b.hi)::int AS installs_active`,
      [from, to, tz]);
    return r!;
  }

  /** Стоимость ИИ — по прайсу моделей (в базе она есть только у расшифровки), в долларах. */
  private async ai(from: string, to: string, tz: string) {
    const rows = await this.db.many<{ model: string; input: string; output: string; stored: string; calls: number }>(
      `WITH b AS (SELECT ($1::date)::timestamp AT TIME ZONE $3::text AS lo, ($2::date)::timestamp AT TIME ZONE $3::text AS hi)
       SELECT u.model, sum(u.input_tokens)::bigint AS input, sum(u.output_tokens)::bigint AS output,
              sum(coalesce(u.cost_estimate, 0))::float8 AS stored, count(*)::int AS calls
         FROM ai_usage u JOIN (${REAL}) rt ON rt.id=u.tenant_id, b
        WHERE u.created_at >= b.lo AND u.created_at < b.hi AND NOT u.cache_hit
        GROUP BY u.model`, [from, to, tz]);
    let usd = 0; let tokens = 0; let calls = 0;
    for (const r of rows) {
      const i = Number(r.input) || 0; const o = Number(r.output) || 0;
      usd += Number(r.stored) || estimateCost(r.model ?? '', i, o);
      tokens += i + o; calls += r.calls;
    }
    return { usd: Math.round(usd * 100) / 100, tokens, calls };
  }

  /** Подписки сейчас — тем же правилом, что и сама оплата: статус не хранится, а считается. */
  private async subscriptions() {
    const rows = await this.db.many<SubRow & { created_at: Date; has_row: boolean }>(
      `SELECT rt.created_at, s.tenant_id IS NOT NULL AS has_row, s.status, s.plan_code, s.trial_ends_at, s.current_period_end,
              coalesce(s.complimentary, false) AS complimentary
         FROM (${REAL}) rt LEFT JOIN tenant_subscriptions s ON s.tenant_id=rt.id`);
    const now = new Date();
    const out = { trial: 0, paying: 0, grace: 0, readOnly: 0, complimentary: 0 };
    for (const r of rows) {
      const e = effective(r.has_row ? r : null, new Date(r.created_at), now);
      if (e.complimentary) out.complimentary += 1;
      else if (e.status === 'TRIAL') out.trial += 1;
      else if (e.status === 'ACTIVE') out.paying += 1;
      else if (e.status === 'GRACE') out.grace += 1;
      else out.readOnly += 1;
    }
    return out;
  }

  /** Регистрации по дням (до трёх месяцев) или по месяцам — в отчётном поясе. */
  private async series(p: Period, tz: string) {
    const unit = p.days <= 93 ? 'day' : 'month';
    const rows = await this.db.many<{ bucket: string; users: number; companies: number }>(
      `WITH b AS (SELECT ($1::date)::timestamp AT TIME ZONE $3::text AS lo, ($2::date)::timestamp AT TIME ZONE $3::text AS hi),
            rt AS (${REAL}),
            ra AS (SELECT DISTINCT u.account_id AS id FROM users u JOIN rt ON rt.id=u.tenant_id WHERE u.account_id IS NOT NULL),
            ev AS (
              SELECT date_trunc($4::text, a.created_at AT TIME ZONE $3::text) AS bucket, 1 AS u, 0 AS c
                FROM accounts a JOIN ra ON ra.id=a.id, b WHERE a.created_at >= b.lo AND a.created_at < b.hi
              UNION ALL
              SELECT date_trunc($4::text, rt.created_at AT TIME ZONE $3::text), 0, 1
                FROM rt, b WHERE rt.created_at >= b.lo AND rt.created_at < b.hi)
       SELECT to_char(bucket, 'YYYY-MM-DD') AS bucket, sum(u)::int AS users, sum(c)::int AS companies
         FROM ev GROUP BY bucket ORDER BY bucket`, [p.from, p.to, tz, unit]);
    return { unit, points: rows };
  }

  async overview(p: Period, tz: string) {
    const [cur, prev, ai, prevAi, subs, series] = await Promise.all([
      this.counts(p.from, p.to, tz), this.counts(p.prevFrom, p.prevTo, tz),
      this.ai(p.from, p.to, tz), this.ai(p.prevFrom, p.prevTo, tz),
      this.subscriptions(), this.series(p, tz),
    ]);
    const m = (cur: number, prev: number) => ({ value: cur, prev, deltaPct: deltaPct(cur, prev) });
    return {
      period: { from: p.from, toInclusive: dayBefore(p.to), days: p.days, tz, prevFrom: p.prevFrom, prevToInclusive: dayBefore(p.prevTo) },
      generatedAt: new Date().toISOString(),
      activityRule: ACTIVITY_VERSION,
      metrics: {
        usersNew: m(cur.users_new, prev.users_new),
        usersTotal: { value: cur.users_total },
        emailVerified: m(cur.verified_new, prev.verified_new),
        joinedByInvite: m(cur.joined_invite, prev.joined_invite),
        companiesNew: m(cur.companies_new, prev.companies_new),
        companiesTotal: { value: cur.companies_total },
        activeUsers: m(cur.active_users, prev.active_users),
        revenueRub: m(cur.revenue_rub, prev.revenue_rub),
        payments: m(cur.payments, prev.payments),
        newPaying: m(cur.new_paying, prev.new_paying),
        aiCostUsd: m(ai.usd, prevAi.usd),
        aiTokens: m(ai.tokens, prevAi.tokens),
        supportNew: m(cur.support_new, prev.support_new),
        installsNew: m(cur.installs_new, prev.installs_new),
        installsActive: m(cur.installs_active, prev.installs_active),
      },
      subscriptions: subs,
      series,
      /** Чего пока нет в данных — показываем «нет данных», а не ноль (§5.3). */
      unavailable: ['downloads', 'refunds', 'pwaInstalls', 'storeInstalls'],
      sources: {
        installs: 'приложение Android: первый запуск экземпляра (mobile_devices)',
        revenue: 'ЮKassa: подтверждённые платежи',
        aiCost: 'оценка по прайсу моделей, USD',
      },
    };
  }

  /** Расход ИИ за текущий месяц (UTC) по компаниям: чей ключ и сколько. Без текстов запросов. */
  async aiMonth() {
    const rows = await this.db.many<{ tenant_id: string; name: string; is_test: boolean; own_key: boolean; model: string; input: string; output: string; stored: string; calls: number }>(
      `SELECT t.id::text AS tenant_id, t.name, t.is_test,
              (s.openai_key_enc IS NOT NULL OR s.anthropic_key_enc IS NOT NULL OR s.openrouter_key_enc IS NOT NULL OR s.kimi_key_enc IS NOT NULL) AS own_key,
              u.model, sum(u.input_tokens)::bigint AS input, sum(u.output_tokens)::bigint AS output,
              sum(coalesce(u.cost_estimate, 0))::float8 AS stored, count(*)::int AS calls
         FROM ai_usage u JOIN tenants t ON t.id=u.tenant_id LEFT JOIN ai_settings s ON s.tenant_id=u.tenant_id
        WHERE u.created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND NOT u.cache_hit
        GROUP BY t.id, t.name, t.is_test, own_key, u.model`);
    const by = new Map<string, { tenantId: string; name: string; isTest: boolean; ownKey: boolean; usd: number; tokens: number; calls: number }>();
    for (const r of rows) {
      const i = Number(r.input) || 0; const o = Number(r.output) || 0;
      const cur = by.get(r.tenant_id) ?? { tenantId: r.tenant_id, name: r.name, isTest: r.is_test, ownKey: !!r.own_key, usd: 0, tokens: 0, calls: 0 };
      cur.usd += Number(r.stored) || estimateCost(r.model ?? '', i, o);
      cur.tokens += i + o; cur.calls += r.calls;
      by.set(r.tenant_id, cur);
    }
    return [...by.values()].map((x) => ({ ...x, usd: Math.round(x.usd * 100) / 100 })).sort((a, b) => b.usd - a.usd);
  }

  // ── Компании ──
  tenants() {
    return this.db.many<{
      id: string; name: string; created_at: Date; is_test: boolean; is_platform: boolean; people: number;
      last_active: Date | null; plan_code: string | null; sub_status: string | null; complimentary: boolean | null;
    }>(
      `SELECT t.id::text, t.name, t.created_at, t.is_test, t.is_platform,
              (SELECT count(*) FROM users u WHERE u.tenant_id=t.id AND u.is_active)::int AS people,
              (SELECT max(u.last_seen_at) FROM users u WHERE u.tenant_id=t.id) AS last_active,
              s.plan_code, s.status AS sub_status, s.complimentary
         FROM tenants t LEFT JOIN tenant_subscriptions s ON s.tenant_id=t.id
        ORDER BY t.is_test, t.created_at DESC`);
  }

  async setTest(tenantId: string, isTest: boolean) {
    const r = await this.db.query(`UPDATE tenants SET is_test=$2 WHERE id=$1 AND NOT is_platform`, [tenantId, isTest]);
    return (r.rowCount ?? 0) > 0;
  }

  // ── Объявление для всех пользователей CRM (то же, что /platform/notice) ──
  notice() {
    return this.db.one<{ id: string; text: string; level: string; ends_at: Date }>(
      `SELECT id::text, text, level, ends_at FROM system_notices WHERE starts_at <= now() AND ends_at > now() ORDER BY id DESC LIMIT 1`);
  }

  async setNotice(text: string, minutes: number, level: 'info' | 'warn') {
    await this.clearNotice();
    return this.db.one<{ id: string; ends_at: Date }>(
      `INSERT INTO system_notices (text, level, ends_at) VALUES ($1, $2, now() + ($3::int * interval '1 minute')) RETURNING id::text, ends_at`,
      [text.trim(), level, minutes]);
  }

  async clearNotice() {
    await this.db.query(`UPDATE system_notices SET ends_at = now() WHERE ends_at > now()`);
  }
}

function dayBefore(d: string): string {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}
