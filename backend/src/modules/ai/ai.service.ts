import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { RedisService } from '../../cache/redis.service';
import { AiProvider, MockAiProvider, RealAiProvider } from './ai.provider';
import { maskPII } from './pii';
import { StandupPackage, validateStandupPackage } from './standup-schema';

const CACHE_TTL = 3600;

/**
 * Единая точка egress к LLM/Whisper (master → AI-слой). Маскирование PII встроено
 * и НЕОТКЛЮЧАЕМО для текста, идущего в модель. Кэш ответов в Redis по (tenant + вход).
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger('AI');
  private readonly provider: AiProvider;

  constructor(config: ConfigService, private readonly redis: RedisService) {
    const openai = config.get<string>('OPENAI_API_KEY');
    const anthropic = config.get<string>('ANTHROPIC_API_KEY');
    const model = config.get<string>('AI_PARSER_MODEL') ?? 'claude-haiku-4-5';
    this.provider = openai || anthropic ? new RealAiProvider(openai, anthropic, model) : new MockAiProvider();
    this.logger.log(`AI provider: ${this.provider.name}`);
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
