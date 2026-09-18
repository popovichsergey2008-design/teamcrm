import { Injectable, Logger } from '@nestjs/common';
import { AiGateway, AiPriority } from './ai-gateway';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { RedisService } from '../../cache/redis.service';
import { DbService } from '../../database/db.service';
import { AiProvider, MockAiProvider, RealAiProvider, TranscriptSegment } from './ai.provider';
import { AiSettingsService } from './ai-settings.service';
import { PromptsService } from '../prompts/prompts.service';
import { maskPII } from './pii';
import { AI_FEATURES, describeFeature, estimateCost, isMockModel } from './usage-catalog';
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
  private readonly parserModel: string;

  constructor(
    config: ConfigService,
    private readonly redis: RedisService,
    private readonly db: DbService,
    private readonly settings: AiSettingsService,
    private readonly prompts: PromptsService,
    private readonly gateway: AiGateway,
  ) {
    this.parserModel = config.get<string>('AI_PARSER_MODEL') ?? 'claude-haiku-4-5';
  }

  /** Подпись модели эмбеддингов арендатора: индекс должен помнить, чем его считали. */
  async embedModelFor(tenantId: string): Promise<string> {
    return (await this.providerFor(tenantId)).embedModel;
  }

  /** Провайдер для конкретного арендатора (BYOK: ключ арендатора > глобальный .env). */
  private async providerFor(tenantId: string) {
    const s = await this.settings.resolve(tenantId);
    const provider: AiProvider = (s.openaiKey || s.anthropicKey || s.openrouterKey)
      ? new RealAiProvider(s.openaiKey, s.anthropicKey, this.parserModel, s.brainModel, s.openrouterKey)
      : new MockAiProvider();
    const embedModel = (s.openaiKey || s.openrouterKey) ? 'text-embedding-3-small' : 'mock-embed';
    const brainModel = s.brainModel
      ?? (s.anthropicKey ? 'claude-3-5-sonnet' : s.openaiKey ? 'gpt-4o-mini' : s.openrouterKey ? 'meta-llama/llama-3.3-70b-instruct:free' : 'mock-llm');
    return { provider, embedModel, brainModel };
  }

  transcribe(tenantId: string, audioRefOrText: string): Promise<string> {
    return this.providerFor(tenantId).then((p) => p.provider.transcribe(audioRefOrText));
  }

  /** Веб-запись голоса (аудио-буфер) → текст через Whisper (mock → '' при отсутствии ключа). */
  transcribeAudio(tenantId: string, audio: Buffer, filename: string, hint?: string): Promise<string> {
    return this.providerFor(tenantId).then((p) => p.provider.transcribeAudio(audio, filename, hint));
  }

  /**
   * Стенограмма встречи с таймкодами. Куски режет вызывающий — у Whisper лимит 25 МБ.
   * PII здесь не маскируется: замаскировать речь в аудио нельзя. Маскирование применяется
   * дальше, к тексту стенограммы, перед отправкой в LLM на разбор.
   */
  async transcribeSegments(
    tenantId: string, audio: Buffer, filename: string, seconds: number, hint?: string,
  ): Promise<TranscriptSegment[]> {
    const { provider } = await this.providerFor(tenantId);
    const segments = await provider.transcribeSegments(audio, filename, hint);
    // Whisper тарифицируется по минутам звука, а не по токенам — пишем в расход стоимость
    const cost = Number(((Math.max(seconds, 0) / 60) * 0.006).toFixed(4));
    await this.recordUsage(tenantId, 'meeting_transcribe', provider.name === 'mock' ? 'mock-stt' : 'whisper-1', 0, 0, false, cost);
    return segments;
  }

  /**
   * Аналитическая генерация (AI Brain): маскирование PII + метеринг.
   * opts (PromptOps): переопределение модели/лимита и привязка расхода к версии промпта.
   */
  /**
   * Что важнее при заторе.
   *
   * Модель — общий и узкий ресурс, и очередь «кто пришёл, того и обслужили» означает,
   * что человек в поддержке ждёт, пока досчитается ночная сводка. Уровень выводим из
   * названия возможности: так его не нужно проставлять в тридцати местах вызова, и он
   * не разойдётся с правдой, когда появится тридцать первое.
   */
  private priorityOf(feature: string): AiPriority {
    if (feature.startsWith('support')) return 'support';
    if (feature === 'embedding') return 'index';
    if (feature.includes('summary') || feature.includes('digest') || feature.includes('standup')) return 'background';
    return 'user';
  }

  async generate(
    tenantId: string, system: string, user: string, feature = 'brain',
    opts?: {
      promptVersionId?: string | null; model?: string | null; params?: Record<string, unknown>;
      /** Скриншоты к запросу: без них проверить «сделано» по картинке невозможно. */
      images?: { mime: string; base64: string }[];
    },
  ): Promise<string> {
    const { provider, brainModel } = await this.providerFor(tenantId);
    const masked = maskPII(user).masked;
    const model = opts?.model || brainModel;
    const maxTokens = typeof opts?.params?.max_tokens === 'number' ? (opts.params.max_tokens as number) : undefined;
    const text = await this.gateway.run(this.priorityOf(feature), () => provider.generate(system, masked, {
      model: opts?.model || undefined, maxTokens, images: opts?.images,
    }));
    // Пишем ту модель, которая ОТВЕТИЛА, а не ту, которую просили: при отказе
    // выбранной модели включается фолбэк, и отчёт о расходе показывал бы красивую
    // неправду — «работает gpt-5», хотя отвечала совсем другая.
    await this.recordUsage(
      tenantId, feature, provider.lastModel || model,
      estimateTokens(system + masked), estimateTokens(text), false, 0, opts?.promptVersionId ?? null,
    );
    return text;
  }

  /** Потоковая генерация (Brain «печатается»): маскирование + метеринг как в generate(); onDelta — фрагменты. */
  async generateStream(
    tenantId: string, system: string, user: string, onDelta: (t: string) => void, feature = 'brain',
    opts?: { promptVersionId?: string | null; model?: string | null; params?: Record<string, unknown> },
  ): Promise<string> {
    const { provider, brainModel } = await this.providerFor(tenantId);
    const masked = maskPII(user).masked;
    const model = opts?.model || brainModel;
    const maxTokens = typeof opts?.params?.max_tokens === 'number' ? (opts.params.max_tokens as number) : undefined;
    const text = await this.gateway.run(
      this.priorityOf(feature),
      () => provider.generateStream(system, masked, { model: opts?.model || undefined, maxTokens }, onDelta),
    );
    await this.recordUsage(
      tenantId, feature, provider.lastModel || model,
      estimateTokens(system + masked), estimateTokens(text), false, 0, opts?.promptVersionId ?? null,
    );
    return text;
  }

  /** Эмбеддинг текста (PII маскируется до провайдера) + durable-метеринг. */
  async embed(tenantId: string, text: string, feature = 'embedding'): Promise<number[]> {
    const { provider, embedModel } = await this.providerFor(tenantId);
    const { masked } = maskPII(text);
    // Индексация — самая терпеливая работа в системе: пропускаем вперёд всех живых.
    const vec = await this.gateway.run(this.priorityOf(feature), () => provider.embed(masked));
    await this.recordUsage(tenantId, feature, embedModel, estimateTokens(masked), 0, false);
    return vec;
  }

  /** Агрегаты ИИ-расхода (мониторинг): вызовы, cache-hit, токены по фичам. */
  /**
   * Расход ИИ: сколько, на что и когда.
   *
   * Отчёт отвечает на три разных вопроса, и все три задавались вслух. «Сколько ушло» —
   * токены и деньги. «На что» — по возможностям системы, включая те, которые за период
   * НЕ сработали ни разу: ноль напротив строки объясняет ощущение «ИИ будто не
   * вызывается» лучше любого объяснения. «Когда» — по дням, чтобы всплеск было видно
   * глазами и можно было вспомнить, что в тот день делали.
   *
   * Деньги считаем здесь, а не берём из базы: `cost_estimate` заполняется только для
   * расшифровки записей, у текстовых моделей там нули, и отчёт показывал бы «0 ₽»
   * при миллионах токенов.
   */
  async usageStats(tenantId: string, days = 30) {
    const [rows, byDay] = await Promise.all([
      this.db.many<{
        feature: string; model: string; calls: string; hits: string;
        input_tokens: string; output_tokens: string; stored_cost: string; last_at: Date;
      }>(
        `SELECT feature, model, count(*)::int AS calls, sum((cache_hit)::int)::int AS hits,
                sum(input_tokens)::bigint AS input_tokens, sum(output_tokens)::bigint AS output_tokens,
                sum(cost_estimate) AS stored_cost, max(created_at) AS last_at
           FROM ai_usage
          WHERE tenant_id=$1 AND created_at > now() - ($2 || ' days')::interval
          GROUP BY feature, model`,
        [tenantId, days],
      ),
      this.db.many<{ day: string; calls: string; tokens: string; models: string[] }>(
        `SELECT to_char(created_at::date, 'YYYY-MM-DD') AS day,
                count(*)::int AS calls,
                sum(input_tokens + output_tokens)::bigint AS tokens,
                array_agg(DISTINCT model) AS models
           FROM ai_usage
          WHERE tenant_id=$1 AND created_at > now() - ($2 || ' days')::interval
          GROUP BY 1 ORDER BY 1`,
        [tenantId, days],
      ),
    ]);

    // Стоимость по дням считаем из тех же строк: отдельный запрос дал бы те же данные
    // ценой второго прохода по таблице.
    const costByDay = new Map<string, number>();
    const byFeature = new Map<string, {
      feature: string; title: string; where: string; group: string;
      calls: number; hits: number; inputTokens: number; outputTokens: number;
      cost: number; models: string[]; mockCalls: number; lastAt: Date | null;
    }>();

    for (const r of rows) {
      const input = Number(r.input_tokens ?? 0);
      const output = Number(r.output_tokens ?? 0);
      const calls = Number(r.calls ?? 0);
      // у расшифровки цена уже посчитана по минутам звука — её и берём
      const cost = Number(r.stored_cost ?? 0) || estimateCost(r.model, input, output);
      const info = describeFeature(r.feature);

      const acc = byFeature.get(r.feature) ?? {
        feature: r.feature, title: info.title, where: info.where, group: info.group,
        calls: 0, hits: 0, inputTokens: 0, outputTokens: 0, cost: 0, models: [] as string[],
        mockCalls: 0, lastAt: null as Date | null,
      };
      acc.calls += calls;
      acc.hits += Number(r.hits ?? 0);
      acc.inputTokens += input;
      acc.outputTokens += output;
      acc.cost += cost;
      acc.models.push(r.model);
      if (isMockModel(r.model)) acc.mockCalls += calls;
      if (!acc.lastAt || (r.last_at && r.last_at > acc.lastAt)) acc.lastAt = r.last_at;
      byFeature.set(r.feature, acc);
    }

    // Дневная стоимость: раскладываем расход строк по дням пропорционально нельзя,
    // поэтому считаем отдельно — по тем же правилам, что и итог.
    const dayCost = await this.db.many<{ day: string; cost: string }>(
      `SELECT to_char(created_at::date, 'YYYY-MM-DD') AS day,
              sum(CASE WHEN cost_estimate > 0 THEN cost_estimate ELSE 0 END) AS cost
         FROM ai_usage
        WHERE tenant_id=$1 AND created_at > now() - ($2 || ' days')::interval
        GROUP BY 1`,
      [tenantId, days],
    );
    for (const d of dayCost) costByDay.set(d.day, Number(d.cost ?? 0));

    const used = [...byFeature.values()].map((f) => ({
      ...f,
      models: [...new Set(f.models)],
      cost: Number(f.cost.toFixed(4)),
      tokens: f.inputTokens + f.outputTokens,
    }));

    // Возможности, которые за период не сработали ни разу. Показываем их наравне
    // с остальными: пустая строка — это ответ, а не отсутствие ответа.
    const idle = AI_FEATURES
      .filter((f) => !byFeature.has(f.key))
      .map((f) => ({
        feature: f.key, title: f.title, where: f.where, group: f.group,
        calls: 0, hits: 0, inputTokens: 0, outputTokens: 0, tokens: 0, cost: 0,
        models: [] as string[], mockCalls: 0, lastAt: null as Date | null,
      }));

    const totalCalls = used.reduce((s, f) => s + f.calls, 0);
    const cacheHits = used.reduce((s, f) => s + f.hits, 0);

    return {
      periodDays: days,
      totalCalls,
      cacheHits,
      cacheHitRatio: totalCalls ? Number((cacheHits / totalCalls).toFixed(3)) : 0,
      totalTokens: used.reduce((s, f) => s + f.tokens, 0),
      inputTokens: used.reduce((s, f) => s + f.inputTokens, 0),
      outputTokens: used.reduce((s, f) => s + f.outputTokens, 0),
      totalCost: Number(used.reduce((s, f) => s + f.cost, 0).toFixed(4)),
      /** Вызовы, ушедшие в заглушку: конвейер сработал, но думала не модель. */
      mockCalls: used.reduce((s, f) => s + f.mockCalls, 0),
      byFeature: [...used, ...idle].sort((a, b) => b.tokens - a.tokens || a.title.localeCompare(b.title, 'ru')),
      byDay: byDay.map((d) => ({
        day: d.day,
        calls: Number(d.calls ?? 0),
        tokens: Number(d.tokens ?? 0),
        cost: Number((costByDay.get(d.day) ?? 0).toFixed(4)),
        models: d.models ?? [],
      })),
    };
  }

  /**
   * Пробный вызов выбранной модели.
   *
   * Список моделей в настройках приходит из API провайдера, но «модель есть в списке»
   * и «модель отвечает на наши запросы» — разные вещи: часть моделей живёт в другом
   * API, часть недоступна аккаунту. Раньше это выяснялось молча — запрос падал,
   * включался фолбэк, и человек считал, что работает выбранная модель.
   */
  async checkModel(tenantId: string): Promise<{
    requested: string; answered: string | null; ok: boolean; fallback: boolean; error: string | null;
  }> {
    const { provider, brainModel } = await this.providerFor(tenantId);
    try {
      const text = await provider.generate(
        'Ответь одним словом: ок.', 'Проверка связи.', { maxTokens: 20 },
      );
      const answered = provider.lastModel ?? null;
      const ok = !!text?.trim() && answered !== 'mock-llm';
      return {
        requested: brainModel,
        answered,
        ok,
        // фолбэк: ответила не та модель, которую выбрали
        fallback: ok && !!answered && answered !== brainModel,
        error: ok ? null : 'Ни одна модель не ответила — работает встроенная заглушка.',
      };
    } catch (e) {
      return { requested: brainModel, answered: null, ok: false, fallback: false, error: (e as Error).message };
    }
  }

  /** Durable запись расхода ИИ (для метеринга/биллинга/наблюдаемости). promptVersionId — привязка к версии (PromptOps). */
  async recordUsage(
    tenantId: string, feature: string, model: string, inputTokens: number, outputTokens: number, cacheHit: boolean,
    cost = 0, promptVersionId: string | null = null,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO ai_usage (tenant_id, feature, model, input_tokens, output_tokens, cache_hit, cost_estimate, prompt_version_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tenantId, feature, model, inputTokens, outputTokens, cacheHit, cost, promptVersionId],
    ).catch((e) => this.logger.warn(`ai_usage write failed: ${(e as Error).message}`));
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

    // PromptOps: версионируемая инструкция парсера (фолбэк — встроенный дефолт провайдера).
    const prompt = await this.prompts.resolve(tenantId, 'standup.parse', {});

    const cacheKey = `ai:parse:${tenantId}:${prompt?.versionId ?? 'default'}:${createHash('sha256').update(masked).digest('hex')}`;
    let raw = await this.redis.getJson<unknown>(cacheKey).catch(() => null);
    if (raw === null) {
      const { provider } = await this.providerFor(tenantId);
      raw = await provider.parseIntents(masked, prompt?.body);
      await this.redis.setJson(cacheKey, raw, CACHE_TTL).catch(() => undefined);
      await this.recordUsage(
        tenantId, 'standup_parse', this.parserModel, estimateTokens(masked), 0, false, 0, prompt?.versionId ?? null,
      );
    }

    const result = validateStandupPackage(raw);
    return { masked, pkg: result.value ?? null, errors: result.errors };
  }
}
