import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { AppException } from '../../common/http/app-exception';
import { PushService } from '../notifications/push.service';
import {
  Capabilities, Capability, canSpend, capabilitiesOf, crossedThreshold, effectivePlan, EXTENDED_WEB_CREDITS,
  PlanCode, PlanRow, PlanStatus, periodOf, PLAN_TITLE, TRIAL_DAYS, TRIAL_WEB_CREDITS,
} from './ai-plan.rules';

interface Row extends PlanRow {
  tenant_id: string;
  notified_pct: number;
  notified_period: string | null;
  upgrade_requested_at: Date | null;
  updated_at: Date;
}

export interface WebUsage { used: number; reserved: number; limit: number; hardLimit: boolean; periodStart: Date; periodEnd: Date }

/**
 * Тариф ИИ организации (ТЗ-33): что ей можно, сколько интернет-кредитов осталось,
 * резерв и списание.
 *
 * Сюда стекаются все решения «можно ли ИИ в интернет»: бот не спрашивает тариф сам,
 * он спрашивает `capabilities` и `reserveWeb`. Так новое место с веб-доступом нельзя
 * добавить мимо политики — без резерва кредитов ни один веб-запрос не уходит.
 */
@Injectable()
export class AiPlanService {
  private readonly log = new Logger('AiPlan');
  private readonly cache = new Map<string, { at: number; row: Row | null }>();
  private static readonly TTL_MS = 30_000;

  constructor(private readonly db: DbService, private readonly push: PushService) {}

  async row(tenantId: string): Promise<Row | null> {
    const hit = this.cache.get(tenantId);
    if (hit && Date.now() - hit.at < AiPlanService.TTL_MS) return hit.row;
    const row = await this.db.one<Row>(`SELECT * FROM tenant_ai_plans WHERE tenant_id = $1`, [tenantId]);
    this.cache.set(tenantId, { at: Date.now(), row });
    return row;
  }

  /** Смена тарифа действует сразу (§35): кэш сбрасываем на месте. */
  private invalidate(tenantId: string) { this.cache.delete(tenantId); }

  async capabilities(tenantId: string): Promise<Capabilities> {
    return capabilitiesOf(await this.row(tenantId));
  }

  async can(tenantId: string, cap: Capability): Promise<boolean> {
    return (await this.capabilities(tenantId))[cap];
  }

  /** Почему интернета нет — для объяснения модели и человеку; null — есть. */
  async webBlockReason(tenantId: string): Promise<'plan' | 'trial_expired' | 'suspended' | 'limit' | null> {
    const row = await this.row(tenantId);
    const eff = effectivePlan(row);
    if (!row || row.plan_code !== 'AI_EXTENDED') return 'plan';
    if (eff.trialExpired) return 'trial_expired';
    if (!eff.webActive) return 'suspended';
    const u = await this.webUsage(tenantId);
    if (!canSpend({ used: u.used, reserved: u.reserved, limit: u.limit, need: 1, hardLimit: u.hardLimit })) return 'limit';
    return null;
  }

  async webUsage(tenantId: string): Promise<WebUsage> {
    const row = await this.row(tenantId);
    const p = periodOf(row);
    const r = await this.db.one<{ used: number; reserved: number }>(
      `SELECT
         (SELECT COALESCE(SUM(web_credits), 0)::int FROM ai_usage
           WHERE tenant_id = $1 AND usage_category = 'AI_WEB' AND created_at >= $2 AND created_at < $3) AS used,
         (SELECT COALESCE(SUM(credits), 0)::int FROM ai_web_reservations
           WHERE tenant_id = $1 AND expires_at > now()) AS reserved`,
      [tenantId, p.start, p.end],
    );
    return {
      used: r?.used ?? 0, reserved: r?.reserved ?? 0, limit: row?.included_web_credits ?? 0,
      hardLimit: row?.hard_limit_enabled ?? true, periodStart: p.start, periodEnd: p.end,
    };
  }

  /**
   * Зарезервировать кредиты до веб-запроса (§30–31).
   *
   * Блокировка на организацию: два параллельных запроса не прочитают «осталось 1»
   * одновременно и не уйдут оба. Свой ключ клиента — без резерва: его расход не наш.
   */
  async reserveWeb(tenantId: string, userId: string | null, credits: number): Promise<string> {
    if (!(await this.can(tenantId, 'ai.web_search'))) {
      throw AppException.forbidden('Интернет-ИИ доступен в тарифе «Расширенный»');
    }
    const row = await this.row(tenantId);
    const p = periodOf(row);
    return this.db.withTransaction(async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('ai_web:' || $1::text))`, [tenantId]);
      await c.query(`DELETE FROM ai_web_reservations WHERE tenant_id = $1 AND expires_at <= now()`, [tenantId]);
      const { rows } = await c.query<{ used: number; reserved: number }>(
        `SELECT
           (SELECT COALESCE(SUM(web_credits), 0)::int FROM ai_usage
             WHERE tenant_id = $1 AND usage_category = 'AI_WEB' AND created_at >= $2 AND created_at < $3) AS used,
           (SELECT COALESCE(SUM(credits), 0)::int FROM ai_web_reservations WHERE tenant_id = $1) AS reserved`,
        [tenantId, p.start, p.end],
      );
      const used = rows[0]?.used ?? 0;
      const reserved = rows[0]?.reserved ?? 0;
      const limit = row?.included_web_credits ?? 0;
      if (!canSpend({ used, reserved, limit, need: credits, hardLimit: row?.hard_limit_enabled ?? true })) {
        throw AppException.conflict(`Исчерпан лимит интернет-запросов: ${used} из ${limit}`);
      }
      const ins = await c.query<{ id: string }>(
        `INSERT INTO ai_web_reservations (tenant_id, user_id, credits) VALUES ($1, $2, $3) RETURNING id::text`,
        [tenantId, userId, credits],
      );
      return ins.rows[0].id;
    });
  }

  /**
   * Списать по факту и снять резерв — одной транзакцией. `requestId` защищает от
   * двойного списания при повторе (§74): второй такой же запрос просто не запишется.
   */
  async commitWeb(tenantId: string, reservationId: string | null, e: {
    userId: string | null; requestId: string; feature: string; provider: string;
    webRequests: number; pagesFetched: number; bytes: number; credits: number;
  }): Promise<void> {
    const row = await this.row(tenantId);
    await this.db.withTransaction(async (c) => {
      if (reservationId) await c.query(`DELETE FROM ai_web_reservations WHERE id = $1 AND tenant_id = $2`, [reservationId, tenantId]);
      await c.query(
        `INSERT INTO ai_usage (tenant_id, user_id, request_id, feature, model, provider, usage_category,
                               web_requests, pages_fetched, bytes_processed, web_credits, plan_code)
         VALUES ($1, $2, $3, $4, $5, $5, 'AI_WEB', $6, $7, $8, $9, $10)
         ON CONFLICT (tenant_id, request_id) WHERE request_id IS NOT NULL DO NOTHING`,
        [tenantId, e.userId, e.requestId, e.feature, e.provider, e.webRequests, e.pagesFetched, e.bytes, e.credits, row?.plan_code ?? null],
      );
    });
    if (e.credits > 0) void this.warnIfCrossed(tenantId).catch((err) => this.log.warn(`порог лимита: ${(err as Error).message}`));
  }

  async releaseWeb(tenantId: string, reservationId: string | null): Promise<void> {
    if (!reservationId) return;
    await this.db.query(`DELETE FROM ai_web_reservations WHERE id = $1 AND tenant_id = $2`, [reservationId, tenantId]).catch(() => undefined);
  }

  /** 50 / 80 / 100% лимита — владельцу и руководителям, по разу на порог за период (§33). */
  private async warnIfCrossed(tenantId: string): Promise<void> {
    const row = await this.row(tenantId);
    if (!row) return;
    const u = await this.webUsage(tenantId);
    const key = periodOf(row).key;
    const already = row.notified_period === key ? row.notified_pct : 0;
    const hit = crossedThreshold(u.used, u.limit, already);
    if (!hit) return;
    const upd = await this.db.one<{ ok: number }>(
      `UPDATE tenant_ai_plans SET notified_pct = $2, notified_period = $3
        WHERE tenant_id = $1 AND (notified_period IS DISTINCT FROM $3 OR notified_pct < $2) RETURNING 1 AS ok`,
      [tenantId, hit, key],
    );
    this.invalidate(tenantId);
    if (!upd) return; // другой процесс уже сказал
    const body = hit >= 100
      ? `Интернет-лимит ИИ исчерпан: ${u.used} из ${u.limit}. ИИ внутри QEVO работает как обычно, интернет — до нового периода.`
      : `Использовано ${hit}% месячного интернет-лимита ИИ: ${u.used} из ${u.limit}.`;
    const managers = await this.db.many<{ id: string }>(
      `SELECT u.id::text FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.tenant_id = $1 AND u.is_active AND r.code IN ('owner', 'manager')`, [tenantId]);
    for (const m of managers) {
      await this.push.personal({ tenantId, userId: m.id, eventKey: 'ai.web_limit', title: 'Интернет-ИИ', body, path: '/settings/ai-plan' })
        .catch(() => false);
    }
  }

  // ───────────────────────── смена тарифа ─────────────────────────

  /**
   * Выбор при регистрации (§9, решение 15.10): «Расширенный» — пробный на 14 дней с
   * маленьким жёстким лимитом; «Базовый» — сразу действующий. Выбирают один раз:
   * дальше тариф меняет вендор (оплаты нет) или владелец понижает сам.
   */
  async select(tenantId: string, userId: string, plan: PlanCode) {
    const cur = await this.row(tenantId);
    if (cur) throw AppException.conflict('Тариф уже выбран. Сменить его можно в «Настройки → Тариф и ИИ».');
    const trial = plan === 'AI_EXTENDED';
    await this.db.query(
      `INSERT INTO tenant_ai_plans (tenant_id, plan_code, status, trial_ends_at, included_web_credits, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId, plan, trial ? 'TRIAL' : 'ACTIVE', trial ? new Date(Date.now() + TRIAL_DAYS * 86_400_000) : null,
        trial ? TRIAL_WEB_CREDITS : 0, userId],
    );
    this.invalidate(tenantId);
    await this.audit(tenantId, userId, 'ai.plan.selected', { plan, trial });
    return this.view(tenantId);
  }

  /** Понижение — сам владелец: новые веб-запросы закрыты, история и отчёты остаются (§36). */
  async downgrade(tenantId: string, userId: string) {
    await this.db.query(
      `INSERT INTO tenant_ai_plans (tenant_id, plan_code, status, included_web_credits, updated_by)
       VALUES ($1, 'AI_BASIC', 'ACTIVE', 0, $2)
       ON CONFLICT (tenant_id) DO UPDATE SET plan_code = 'AI_BASIC', status = 'ACTIVE', trial_ends_at = NULL,
         included_web_credits = 0, updated_by = $2, updated_at = now()`,
      [tenantId, userId],
    );
    this.invalidate(tenantId);
    await this.audit(tenantId, userId, 'ai.plan.downgraded', {});
    return this.view(tenantId);
  }

  /** Повышение — заявкой: оплаты в продукте нет, включает вендор в консоли. */
  async requestUpgrade(tenantId: string, userId: string) {
    await this.db.query(
      `INSERT INTO tenant_ai_plans (tenant_id, plan_code, status, upgrade_requested_at, updated_by)
       VALUES ($1, 'AI_BASIC', 'ACTIVE', now(), $2)
       ON CONFLICT (tenant_id) DO UPDATE SET upgrade_requested_at = now(), updated_at = now()`,
      [tenantId, userId],
    );
    this.invalidate(tenantId);
    await this.audit(tenantId, userId, 'ai.plan.upgrade_requested', {});
    return this.view(tenantId);
  }

  async setHardLimit(tenantId: string, userId: string, on: boolean) {
    await this.db.query(
      `UPDATE tenant_ai_plans SET hard_limit_enabled = $2, updated_by = $3, updated_at = now() WHERE tenant_id = $1`,
      [tenantId, on, userId],
    );
    this.invalidate(tenantId);
    await this.audit(tenantId, userId, 'ai.limits.changed', { hardLimit: on });
    return this.view(tenantId);
  }

  /** Консоль вендора: тариф, статус, кредиты, срок пробного — как договорились с клиентом. */
  async setByVendor(tenantId: string, actorId: string, p: {
    plan: PlanCode; status: PlanStatus; webCredits?: number; trialDays?: number | null; hardLimit?: boolean;
  }) {
    const credits = p.webCredits ?? (p.plan === 'AI_EXTENDED' ? EXTENDED_WEB_CREDITS : 0);
    const trialEnds = p.status === 'TRIAL' ? new Date(Date.now() + (p.trialDays ?? TRIAL_DAYS) * 86_400_000) : null;
    await this.db.query(
      `INSERT INTO tenant_ai_plans (tenant_id, plan_code, status, trial_ends_at, included_web_credits, hard_limit_enabled, updated_by)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, TRUE), $7)
       ON CONFLICT (tenant_id) DO UPDATE SET plan_code = $2, status = $3, trial_ends_at = $4,
         included_web_credits = $5, hard_limit_enabled = COALESCE($6, tenant_ai_plans.hard_limit_enabled),
         started_at = CASE WHEN $3 = 'TRIAL' THEN now() ELSE tenant_ai_plans.started_at END,
         upgrade_requested_at = CASE WHEN $2 = 'AI_EXTENDED' THEN NULL ELSE tenant_ai_plans.upgrade_requested_at END,
         notified_pct = 0, notified_period = NULL, updated_by = $7, updated_at = now()`,
      [tenantId, p.plan, p.status, trialEnds, credits, p.hardLimit ?? null, actorId],
    );
    this.invalidate(tenantId);
    await this.audit(tenantId, actorId, 'ai.plan.vendor_set', { ...p, webCredits: credits });
  }

  /** Всё про тариф для экрана «Тариф и ИИ». */
  async view(tenantId: string) {
    const row = await this.row(tenantId);
    const eff = effectivePlan(row);
    const web = await this.webUsage(tenantId);
    const [internal, byFeature, byUser] = await Promise.all([
      this.db.one<{ tokens: number; calls: number }>(
        `SELECT COALESCE(SUM(input_tokens + output_tokens), 0)::bigint::float8 AS tokens, COUNT(*)::int AS calls FROM ai_usage
          WHERE tenant_id = $1 AND usage_category <> 'AI_WEB' AND created_at >= date_trunc('month', now())`, [tenantId]),
      this.db.many<{ feature: string; credits: number; pages: number; searches: number }>(
        `SELECT feature, SUM(web_credits)::int AS credits, SUM(pages_fetched)::int AS pages, SUM(web_requests)::int AS searches
           FROM ai_usage WHERE tenant_id = $1 AND usage_category = 'AI_WEB' AND created_at >= $2 AND created_at < $3
          GROUP BY feature ORDER BY 2 DESC`, [tenantId, web.periodStart, web.periodEnd]),
      // по людям — не оценка продуктивности (§40), а ответ на «кто израсходовал лимит»
      this.db.many<{ user_id: string; name: string; credits: number }>(
        `SELECT a.user_id::text, COALESCE(u.full_name, '—') AS name, SUM(a.web_credits)::int AS credits
           FROM ai_usage a LEFT JOIN users u ON u.id = a.user_id
          WHERE a.tenant_id = $1 AND a.usage_category = 'AI_WEB' AND a.created_at >= $2 AND a.created_at < $3 AND a.user_id IS NOT NULL
          GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20`, [tenantId, web.periodStart, web.periodEnd]),
    ]);
    // прогноз до конца периода при нынешнем темпе (§61) — оценка, не счёт
    const elapsed = Math.max(1, (Date.now() - web.periodStart.getTime()) / 86_400_000);
    const total = Math.max(1, (web.periodEnd.getTime() - web.periodStart.getTime()) / 86_400_000);
    return {
      selected: !!row,
      plan: row?.plan_code ?? null,
      planTitle: row ? PLAN_TITLE[row.plan_code] : null,
      status: row?.status ?? null,
      trialEndsAt: row?.trial_ends_at ?? null,
      trialExpired: eff.trialExpired,
      webActive: eff.webActive,
      upgradeRequestedAt: row?.upgrade_requested_at ?? null,
      capabilities: capabilitiesOf(row),
      web: { ...web, forecast: Math.round((web.used / elapsed) * total) },
      internal: { tokens: Number(internal?.tokens ?? 0), calls: internal?.calls ?? 0 },
      byFeature,
      byUser,
    };
  }

  private async audit(tenantId: string, userId: string | null, action: string, details: Record<string, unknown>) {
    await this.db.query(
      `INSERT INTO security_audit (tenant_id, actor_user_id, event_type, resource_type, resource_id, metadata)
       VALUES ($1, $2::bigint, $3, 'ai_plan', $1::text, $4::jsonb)`,
      [tenantId, userId, action, JSON.stringify(details)],
    ).catch((e) => this.log.warn(`журнал тарифа: ${(e as Error).message}`));
  }
}
