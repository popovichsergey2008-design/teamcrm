import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { RedisService } from '../../cache/redis.service';
import { DbService } from '../../database/db.service';
import { AiProvider, MockAiProvider, RealAiProvider } from './ai.provider';
import { maskPII } from './pii';
import { StandupPackage, validateStandupPackage } from './standup-schema';

const CACHE_TTL = 3600;
const estimateTokens = (s: string) => Math.ceil(s.length / 4);

/**
 * Единая точка egress к LLM/Whisper (master → AI-слой). Маскирование PII встроено
 * и НЕОТКЛЮЧАЕМО для текста, идущего в модель. Кэш ответов в Redis по (tenant + вход).
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger('AI');
  private readonly provider: AiProvider;
  private readonly embedModel: string;
  private readonly brainModel: string;

  constructor(
    config: ConfigService,
    private readonly redis: RedisService,
    private readonly db: DbService,
  ) {
    const openai = config.get<string>('OPENAI_API_KEY');
    const anthropic = config.get<string>('ANTHROPIC_API_KEY');
    const model = config.get<string>('AI_PARSER_MODEL') ?? 'claude-haiku-4-5';
    const brainModel = config.get<string>('AI_BRAIN_MODEL');
    this.provider = openai || anthropic ? new RealAiProvider(openai, anthropic, model, brainModel) : new MockAiProvider();
    this.embedModel = openai ? 'text-embedding-3-small' : 'mock-embed';
    this.brainModel = brainModel ?? (anthropic ? 'claude-3-5-sonnet' : openai ? 'gpt-4o-mini' : 'mock-llm');
    this.logger.log(`AI provider: ${this.provider.name}`);
  }

  /** Аналитическая генерация (AI Brain): маскирование PII + метеринг. */
  async generate(tenantId: string, system: string, user: string, feature = 'brain'): Promise<string> {
    const masked = maskPII(user).masked;
    const text = await this.provider.generate(system, masked);
    await this.recordUsage(tenantId, feature, this.brainModel, estimateTokens(system + masked), estimateTokens(text), false);
    return text;
  }

  /** Эмбеддинг текста (PII маскируется до провайдера) + durable-метеринг. */
  async embed(tenantId: string, text: string, feature = 'embedding'): Promise<number[]> {
    const { masked } = maskPII(text);
    const vec = await this.provider.embed(masked);
    await this.recordUsage(tenantId, feature, this.embedModel, estimateTokens(masked), 0, false);
    return vec;
  }

  /** Агрегаты ИИ-расхода (мониторинг): вызовы, cache-hit, токены по фичам. */
  async usageStats(tenantId: string, days = 30) {
    const byFeature = await this.db.many<any>(
      `SELECT feature, count(*)::int AS calls, sum((cache_hit)::int)::int AS hits,
              sum(input_tokens)::int AS input_tokens, sum(output_tokens)::int AS output_tokens
         FROM ai_usage
        WHERE tenant_id=$1 AND created_at > now() - ($2 || ' days')::interval
        GROUP BY feature ORDER BY feature`,
      [tenantId, days],
    );
    const totalCalls = byFeature.reduce((s, r) => s + Number(r.calls), 0);
    const cacheHits = byFeature.reduce((s, r) => s + Number(r.hits), 0);
    return {
      periodDays: days, byFeature, totalCalls, cacheHits,
      cacheHitRatio: totalCalls ? Number((cacheHits / totalCalls).toFixed(3)) : 0,
    };
  }

  /** Durable запись расхода ИИ (для метеринга/биллинга/наблюдаемости). */
  async recordUsage(
    tenantId: string, feature: string, model: string, inputTokens: number, outputTokens: number, cacheHit: boolean, cost = 0,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO ai_usage (tenant_id, feature, model, input_tokens, output_tokens, cache_hit, cost_estimate)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [tenantId, feature, model, inputTokens, outputTokens, cacheHit, cost],
    ).catch((e) => this.logger.warn(`ai_usage write failed: ${(e as Error).message}`));
  }

  transcribe(audioRefOrText: string): Promise<string> {
    return this.provider.transcribe(audioRefOrText);
  }

  /**
   * Маскирует транскрипт, отправляет в LLM, валидирует по схеме.
   * @returns masked-текст (что ушло в модель) + валидированный пакет (или ошибки).
   */
  async maskAndParse(
    tenantId: string,
    transcript: string,
  ): Promise<{ masked: string; pkg: StandupPackage | null; errors: string[] }> {
    const { masked } = maskPII(transcript);

    const cacheKey = `ai:parse:${tenantId}:${createHash('sha256').update(masked).digest('hex')}`;
    let raw = await this.redis.getJson<unknown>(cacheKey).catch(() => null);
    if (raw === null) {
      raw = await this.provider.parseIntents(masked);
      await this.redis.setJson(cacheKey, raw, CACHE_TTL).catch(() => undefined);
    }

    const result = validateStandupPackage(raw);
    return { masked, pkg: result.value ?? null, errors: result.errors };
  }
}
