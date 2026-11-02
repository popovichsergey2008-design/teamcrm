import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { AI_GUARD_DEFAULT, AiGuardConfig, AiGuardDecision, decide, normalizeGuard } from './ai-guard';
import { estimateCost } from './usage-catalog';

const KEY = 'ai_guard';
const CFG_TTL_MS = 30_000;
const SPEND_TTL_MS = 60_000;
/** Сверка счётчика бюджета с ai_usage и снятие зависших резервов. */
const SYNC_MS = 60_000;
/** Нижняя оценка запроса: у модели вне прайса стоимость считается нулём, а резерв нулём быть не должен. */
const MIN_HOLD_USD = 0.0005;
const monthNow = () => new Date().toISOString().slice(0, 7);

/**
 * Выключатели и бюджет общего ИИ — проверка перед каждым выбором ключа.
 *
 * Настройка и расход кэшируются на 30/60 с: решение спрашивается на каждый вызов модели,
 * и ходить за ним в базу каждый раз нельзя. Выключатель срабатывает за полминуты.
 * База недоступна — живём с последней известной настройкой (§10), а не открываем всё.
 */
@Injectable()
export class AiGuardService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('AiGuard');
  private cfg: { at: number; v: AiGuardConfig } | null = null;
  private spend: { at: number; v: number } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private monthReady: string | null = null;

  constructor(private readonly db: DbService) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => { void this.syncBudget().catch((e) => this.log.warn(`сверка бюджета: ${(e as Error).message}`)); }, SYNC_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ── резервирование до запроса (§5.5, 0227) ──

  /**
   * Зарезервировать оценку запроса общим ключом. Один оператор: проверка «влезает ли
   * в потолок вместе с уже зарезервированным» и резерв — атомарно, параллельные запросы
   * не перебирают потолок. null — потолка нет (резерв не нужен); false — не влезает.
   */
  async reserve(tenantId: string | null, feature: string, estUsd: number): Promise<string | null | false> {
    const cfg = await this.config();
    if (cfg.monthlyBudgetUsd == null) return null;
    const month = monthNow();
    await this.ensureMonth(month);
    const est = Math.max(estUsd || 0, MIN_HOLD_USD);
    const r = await this.db.one<{ id: string }>(
      `WITH up AS (
         UPDATE ai_budget_month SET held_usd = held_usd + $2::numeric
          WHERE month = $1 AND spent_usd + held_usd + $2::numeric <= $3::numeric
          RETURNING month)
       INSERT INTO ai_budget_reservations (month, tenant_id, feature, est_usd)
       SELECT month, $4::bigint, $5::varchar, $2::numeric FROM up RETURNING id::text`,
      [month, est, cfg.monthlyBudgetUsd, tenantId, feature.slice(0, 64)]);
    return r ? r.id : false;
  }

  /**
   * Запрос закончился: резерв — в факт. Ошибка запроса — списываем оценку целиком: была
   * ли платной неудачная попытка, неизвестно; сверка с ai_usage поправит через минуту.
   */
  async settle(id: string, actualUsd: number): Promise<void> {
    await this.db.query(
      `WITH r AS (
         UPDATE ai_budget_reservations SET status='settled', actual_usd=$2::numeric, settled_at=now()
          WHERE id=$1 AND status='held' RETURNING month, est_usd)
       UPDATE ai_budget_month b SET held_usd = greatest(0, b.held_usd - r.est_usd), spent_usd = b.spent_usd + $2::numeric
         FROM r WHERE b.month = r.month`,
      [id, Math.max(actualUsd || 0, 0)]);
  }

  /** Строка месяца — со стартовым расходом из ai_usage, один раз на месяц и процесс. */
  private async ensureMonth(month: string): Promise<void> {
    if (this.monthReady === month) return;
    const spent = await this.sharedSpentUsd(true);
    await this.db.query(`INSERT INTO ai_budget_month (month, spent_usd) VALUES ($1, $2) ON CONFLICT (month) DO NOTHING`, [month, spent]);
    this.monthReady = month;
  }

  /**
   * Раз в минуту: зависшие резервы (процесс упал посреди запроса) — сняты; расход —
   * по ai_usage, источнику правды; зарезервировано — по живым резервам.
   */
  async syncBudget(): Promise<void> {
    const cfg = await this.config();
    if (cfg.monthlyBudgetUsd == null) return;
    const month = monthNow();
    await this.ensureMonth(month);
    await this.db.query(
      `UPDATE ai_budget_reservations SET status='expired', settled_at=now()
        WHERE status='held' AND created_at < now() - interval '10 minutes'`);
    const spent = await this.sharedSpentUsd(true);
    await this.db.query(
      `UPDATE ai_budget_month SET spent_usd = $2,
              held_usd = (SELECT coalesce(sum(est_usd), 0) FROM ai_budget_reservations WHERE month = $1 AND status = 'held'),
              synced_at = now()
        WHERE month = $1`, [month, spent]);
  }

  /** Для консоли владельца: израсходовано и зарезервировано в этом месяце. */
  async budgetNow(): Promise<{ spentUsd: number; heldUsd: number } | null> {
    const r = await this.db.one<{ spent_usd: string; held_usd: string }>(
      `SELECT spent_usd::text, held_usd::text FROM ai_budget_month WHERE month=$1`, [monthNow()]).catch(() => null);
    return r ? { spentUsd: Math.round(Number(r.spent_usd) * 100) / 100, heldUsd: Math.round(Number(r.held_usd) * 10000) / 10000 } : null;
  }

  async config(): Promise<AiGuardConfig> {
    if (this.cfg && Date.now() - this.cfg.at < CFG_TTL_MS) return this.cfg.v;
    try {
      const r = await this.db.one<{ value: unknown }>(`SELECT value FROM platform_settings WHERE key=$1`, [KEY]);
      this.cfg = { at: Date.now(), v: normalizeGuard(r?.value) };
    } catch (e) {
      this.log.warn(`настройка выключателей недоступна: ${(e as Error).message}`);
      if (!this.cfg) return AI_GUARD_DEFAULT;
    }
    return this.cfg!.v;
  }

  async save(v: AiGuardConfig): Promise<void> {
    await this.db.query(
      `INSERT INTO platform_settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [KEY, JSON.stringify(v)]);
    this.cfg = { at: Date.now(), v };
  }

  /**
   * Расход общего ключа за месяц: компании без своих ключей. Стоимость — по прайсу
   * моделей (в базе она есть только у расшифровки), как и в остальных отчётах.
   */
  async sharedSpentUsd(fresh = false): Promise<number> {
    if (!fresh && this.spend && Date.now() - this.spend.at < SPEND_TTL_MS) return this.spend.v;
    try {
      const rows = await this.db.many<{ model: string; input: string; output: string; stored: string }>(
        `SELECT u.model, sum(u.input_tokens)::bigint AS input, sum(u.output_tokens)::bigint AS output,
                sum(coalesce(u.cost_estimate, 0))::float8 AS stored
           FROM ai_usage u
           LEFT JOIN ai_settings s ON s.tenant_id=u.tenant_id
          WHERE u.created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
            AND NOT u.cache_hit
            AND (s.tenant_id IS NULL OR (s.openai_key_enc IS NULL AND s.anthropic_key_enc IS NULL
                 AND s.openrouter_key_enc IS NULL AND s.kimi_key_enc IS NULL))
          GROUP BY u.model`);
      let usd = 0;
      for (const r of rows) usd += Number(r.stored) || estimateCost(r.model ?? '', Number(r.input) || 0, Number(r.output) || 0);
      this.spend = { at: Date.now(), v: Math.round(usd * 100) / 100 };
    } catch (e) {
      this.log.warn(`расход общего ключа не посчитался: ${(e as Error).message}`);
      if (!this.spend) return 0;
    }
    return this.spend!.v;
  }

  /**
   * Решение без ожидания — для синхронных мест (демо в Telegram-боте): по последним
   * известным настройке и расходу, а свежие подтягиваются в фоне к следующему вызову.
   */
  peek(): AiGuardDecision {
    void this.decision().catch(() => undefined);
    const cfg = this.cfg?.v ?? AI_GUARD_DEFAULT;
    return decide(cfg, this.spend?.v ?? 0);
  }

  async decision(): Promise<AiGuardDecision> {
    const cfg = await this.config();
    // без потолка расход не нужен — не считаем зря
    return decide(cfg, cfg.monthlyBudgetUsd != null ? await this.sharedSpentUsd() : 0);
  }
}
