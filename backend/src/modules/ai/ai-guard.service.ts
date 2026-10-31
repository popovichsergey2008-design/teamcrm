import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { AI_GUARD_DEFAULT, AiGuardConfig, AiGuardDecision, decide, normalizeGuard } from './ai-guard';
import { estimateCost } from './usage-catalog';

const KEY = 'ai_guard';
const CFG_TTL_MS = 30_000;
const SPEND_TTL_MS = 60_000;

/**
 * Выключатели и бюджет общего ИИ — проверка перед каждым выбором ключа.
 *
 * Настройка и расход кэшируются на 30/60 с: решение спрашивается на каждый вызов модели,
 * и ходить за ним в базу каждый раз нельзя. Выключатель срабатывает за полминуты.
 * База недоступна — живём с последней известной настройкой (§10), а не открываем всё.
 */
@Injectable()
export class AiGuardService {
  private readonly log = new Logger('AiGuard');
  private cfg: { at: number; v: AiGuardConfig } | null = null;
  private spend: { at: number; v: number } | null = null;

  constructor(private readonly db: DbService) {}

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
