import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DbService } from '../../database/db.service';
import { AiGuardService } from './ai-guard.service';
import { IntegrationCryptoService } from '../integrations/crypto.service';
import { KIMI_BASE_URL, KIMI_DEFAULT_MODEL, KIMI_FALLBACK_MODELS } from './ai.provider';
import { TRIAL_DAYS_DEFAULT, TRIAL_TOKENS_DEFAULT, trialVerdict, TrialVerdict } from './ai-trial';

/** Решение «можно ли общим ключом» живёт минуту: считать токены на каждый вызов модели незачем. */
const TRIAL_CACHE_MS = 60_000;

export interface ResolvedAi {
  openaiKey?: string;
  anthropicKey?: string;
  openrouterKey?: string;
  /** Kimi (Moonshot AI): с ним вся текстовая работа ИИ идёт через Kimi (19.10). */
  kimiKey?: string;
  brainModel?: string;
  source: 'tenant' | 'global' | 'none';
}

/** Бесплатные модели OpenRouter — фолбэк, если их список не отдался (id меняются со временем). */
const OPENROUTER_FREE_FALLBACK = [
  'deepseek/deepseek-chat-v3-0324:free',
  'google/gemini-2.0-flash-exp:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'mistralai/mistral-small-3.1-24b-instruct:free',
  'qwen/qwen-2.5-72b-instruct:free',
];

/** BYOK: ключи ИИ на арендатора (шифрованные в БД). Приоритет — ключ арендатора, иначе глобальный .env. */
@Injectable()
export class AiSettingsService {
  private readonly log = new Logger('AiSettings');
  private readonly globalOpenai?: string;
  private readonly globalAnthropic?: string;
  private readonly globalOpenrouter?: string;
  private readonly globalKimi?: string;
  private readonly globalBrainModel?: string;
  private readonly trialDays: number;
  private readonly trialTokens: number;
  private readonly trialCache = new Map<string, { at: number; v: TrialVerdict }>();

  constructor(
    private readonly db: DbService,
    private readonly crypto: IntegrationCryptoService,
    config: ConfigService,
    private readonly guard: AiGuardService,
  ) {
    this.globalOpenai = config.get<string>('OPENAI_API_KEY');
    this.globalAnthropic = config.get<string>('ANTHROPIC_API_KEY');
    this.globalOpenrouter = config.get<string>('OPENROUTER_API_KEY');
    this.globalKimi = config.get<string>('KIMI_API_KEY') || undefined;
    this.globalBrainModel = config.get<string>('AI_BRAIN_MODEL');
    this.trialDays = Number(config.get('AI_TRIAL_DAYS') ?? TRIAL_DAYS_DEFAULT) || TRIAL_DAYS_DEFAULT;
    this.trialTokens = Number(config.get('AI_TRIAL_TOKENS') ?? TRIAL_TOKENS_DEFAULT) || TRIAL_TOKENS_DEFAULT;
  }

  /**
   * Пробный ИИ общим ключом (#4624, см. ai-trial.ts): площадке вендора — всегда, новой
   * организации — две недели и до лимита токенов. `fresh` — не брать из минутного кэша.
   */
  async trial(tenantId: string, fresh = false): Promise<TrialVerdict> {
    const hit = this.trialCache.get(tenantId);
    if (!fresh && hit && Date.now() - hit.at < TRIAL_CACHE_MS) return hit.v;
    const r = await this.db.one<{
      is_platform: boolean; created_at: Date; status: string | null; started_at: Date | null; trial_ends_at: Date | null;
    }>(
      `SELECT t.is_platform, t.created_at, p.status, p.started_at, p.trial_ends_at
         FROM tenants t LEFT JOIN tenant_ai_plans p ON p.tenant_id = t.id WHERE t.id = $1`,
      [tenantId],
    );
    const planTrial = r?.status === 'TRIAL' && r.started_at && r.trial_ends_at
      ? { startedAt: new Date(r.started_at), endsAt: new Date(r.trial_ends_at) } : null;
    const created = r ? new Date(r.created_at) : new Date(0);
    const pre = trialVerdict({ isPlatform: !!r?.is_platform, tenantCreatedAt: created, planTrial, tokensUsed: 0 }, new Date(), this.trialDays, this.trialTokens);
    // токены считаем только когда окно открыто: у старых компаний и площадки — незачем
    let used = 0;
    if (pre.allowed && pre.reason === 'trial') {
      const u = await this.db.one<{ n: string }>(
        `SELECT COALESCE(SUM(input_tokens + output_tokens), 0)::text AS n FROM ai_usage WHERE tenant_id = $1 AND created_at >= $2`,
        [tenantId, pre.windowStart],
      );
      used = Number(u?.n ?? 0);
    }
    const v = trialVerdict({ isPlatform: !!r?.is_platform, tenantCreatedAt: created, planTrial, tokensUsed: used }, new Date(), this.trialDays, this.trialTokens);
    this.trialCache.set(tenantId, { at: Date.now(), v });
    if (this.trialCache.size > 5000) this.trialCache.clear();
    return v;
  }

  /** Общие ключи сервера без организации (#4619: демо в Telegram-боте до регистрации). */
  globalKeys(): ResolvedAi {
    const s = {
      openaiKey: this.globalOpenai || undefined, anthropicKey: this.globalAnthropic || undefined,
      openrouterKey: this.globalOpenrouter || undefined, kimiKey: this.globalKimi || undefined,
      brainModel: this.globalBrainModel || undefined,
    };
    return { ...s, source: s.openaiKey || s.anthropicKey || s.openrouterKey || s.kimiKey ? 'global' : 'none' };
  }

  private row(tenantId: string) {
    return this.db.one<any>(`SELECT * FROM ai_settings WHERE tenant_id=$1`, [tenantId]);
  }

  /** Публичный статус (без раскрытия ключей). */
  async get(tenantId: string) {
    const r = await this.row(tenantId);
    return {
      openaiKeySet: !!r?.openai_key_enc,
      anthropicKeySet: !!r?.anthropic_key_enc,
      openrouterKeySet: !!r?.openrouter_key_enc,
      kimiKeySet: !!r?.kimi_key_enc,
      brainModel: r?.brain_model ?? this.globalBrainModel ?? null,
      globalOpenai: !!this.globalOpenai,
      globalAnthropic: !!this.globalAnthropic,
      globalOpenrouter: !!this.globalOpenrouter,
      globalKimi: !!this.globalKimi,
      /**
       * Пробный ИИ общим ключом (#4624): показываем, пока своего ключа нет. `serverKey` —
       * есть ли общий ключ на сервере вообще: без него пробовать нечем.
       */
      trial: (r?.openai_key_enc || r?.anthropic_key_enc || r?.openrouter_key_enc || r?.kimi_key_enc) ? null : {
        ...(await this.trial(tenantId, true)),
        serverKey: !!(this.globalOpenai || this.globalAnthropic || this.globalOpenrouter || this.globalKimi),
      },
    };
  }

  /** Сохранить ключи/модель. undefined — не трогать; '' — очистить. */
  async update(tenantId: string, userId: string, patch: { openaiKey?: string; anthropicKey?: string; openrouterKey?: string; kimiKey?: string; brainModel?: string }) {
    const cur = await this.row(tenantId);
    const openaiEnc = patch.openaiKey === undefined ? (cur?.openai_key_enc ?? null)
      : patch.openaiKey ? this.crypto.encrypt(patch.openaiKey.trim()) : null;
    const anthropicEnc = patch.anthropicKey === undefined ? (cur?.anthropic_key_enc ?? null)
      : patch.anthropicKey ? this.crypto.encrypt(patch.anthropicKey.trim()) : null;
    const openrouterEnc = patch.openrouterKey === undefined ? (cur?.openrouter_key_enc ?? null)
      : patch.openrouterKey ? this.crypto.encrypt(patch.openrouterKey.trim()) : null;
    const kimiEnc = patch.kimiKey === undefined ? (cur?.kimi_key_enc ?? null)
      : patch.kimiKey ? this.crypto.encrypt(patch.kimiKey.trim()) : null;
    let brainModel = patch.brainModel === undefined ? (cur?.brain_model ?? null) : (patch.brainModel || null);
    // Новый ключ Kimi без выбранной модели Kimi — переводим работу ИИ на Kimi сразу:
    // ради этого ключ и вводят (19.10, «перевести всю работу ИИ на эту модель»).
    if (patch.kimiKey && patch.brainModel === undefined && !/^kimi/i.test(brainModel ?? '')) brainModel = KIMI_DEFAULT_MODEL;
    // Ключ Kimi сняли — модель Kimi без ключа никуда не ведёт, возвращаем выбор по умолчанию.
    if (patch.kimiKey === '' && /^kimi/i.test(brainModel ?? '') && !this.globalKimi) brainModel = null;
    await this.db.query(
      `INSERT INTO ai_settings (tenant_id, openai_key_enc, anthropic_key_enc, openrouter_key_enc, kimi_key_enc, brain_model, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now())
       ON CONFLICT (tenant_id) DO UPDATE SET
         openai_key_enc=EXCLUDED.openai_key_enc, anthropic_key_enc=EXCLUDED.anthropic_key_enc,
         openrouter_key_enc=EXCLUDED.openrouter_key_enc, kimi_key_enc=EXCLUDED.kimi_key_enc,
         brain_model=EXCLUDED.brain_model, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [tenantId, openaiEnc, anthropicEnc, openrouterEnc, kimiEnc, brainModel, userId],
    );
    return this.get(tenantId);
  }

  /** Разрешить действующие ключи/модель для арендатора (ключ арендатора > глобальный). */
  async resolve(tenantId: string): Promise<ResolvedAi> {
    const r = await this.row(tenantId).catch(() => null);
    const dec = (enc?: string | null) => { try { return enc ? this.crypto.decrypt(enc) : undefined; } catch { return undefined; } };
    const tOpenai = dec(r?.openai_key_enc);
    const tAnthropic = dec(r?.anthropic_key_enc);
    const tOpenrouter = dec(r?.openrouter_key_enc);
    const tKimi = dec(r?.kimi_key_enc);
    // Выключатели и бюджет владельца платформы (консоль владельца): решение — до выбора
    // ключа, поэтому резервный провайдер его не обходит. Весь ИИ выключен — как без ключа:
    // возможности уходят на правила, как у компании без ИИ.
    const verdict = await this.guard.decision().catch(() => ({ any: true, shared: true, reason: null }));
    if (!verdict.any) return { brainModel: r?.brain_model || this.globalBrainModel, source: 'none' };
    const own = !!(tOpenai || tAnthropic || tOpenrouter || tKimi);
    // общий ключ сервера — только площадке вендора и новой компании в пробный период (#4624)
    const useGlobal = !own && verdict.shared && (this.globalOpenai || this.globalAnthropic || this.globalOpenrouter || this.globalKimi)
      ? (await this.trial(tenantId).catch(() => null))?.allowed === true
      : own;
    const g = (v?: string) => (useGlobal ? v : undefined);
    const openaiKey = tOpenai || g(this.globalOpenai);
    const anthropicKey = tAnthropic || g(this.globalAnthropic);
    const openrouterKey = tOpenrouter || g(this.globalOpenrouter);
    const kimiKey = tKimi || g(this.globalKimi);
    const brainModel = r?.brain_model || this.globalBrainModel;
    const source: ResolvedAi['source'] = own ? 'tenant'
      : (openaiKey || anthropicKey || openrouterKey || kimiKey) ? 'global' : 'none';
    return { openaiKey, anthropicKey, openrouterKey, kimiKey, brainModel, source };
  }

  /** Список доступных чат-моделей: по ключу OpenAI + бесплатные модели OpenRouter (если задан его ключ). */
  async listModels(tenantId: string): Promise<string[]> {
    const { openaiKey, openrouterKey, kimiKey } = await this.resolve(tenantId);
    const kimi = kimiKey ? await this.kimiModels(kimiKey) : [];
    const openai = openaiKey ? await this.openaiModels(openaiKey) : [];
    const openrouter = openrouterKey ? await this.openrouterFreeModels() : [];
    const all = [...kimi, ...openai, ...openrouter];
    return all.length ? all : ['gpt-4o-mini', 'gpt-4o'];
  }

  /** Чат-модели Kimi по ключу; не отдались — известный список (октябрь 2026). */
  private async kimiModels(kimiKey: string): Promise<string[]> {
    try {
      const res = await fetch(`${KIMI_BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${kimiKey}` }, signal: AbortSignal.timeout(15000),
      });
      const json: any = await res.json();
      const ids: string[] = (json?.data ?? []).map((m: any) => m.id).filter((id: any) => typeof id === 'string' && /^kimi/i.test(id));
      return ids.length ? [KIMI_DEFAULT_MODEL, ...ids.filter((x) => x !== KIMI_DEFAULT_MODEL).sort()] : KIMI_FALLBACK_MODELS;
    } catch (e) {
      this.log.warn(`kimiModels failed: ${(e as Error).message}`);
      return KIMI_FALLBACK_MODELS;
    }
  }

  private async openaiModels(openaiKey: string): Promise<string[]> {
    const fallback = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'o4-mini'];
    try {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${openaiKey}` }, signal: AbortSignal.timeout(15000),
      });
      const json: any = await res.json();
      const ids: string[] = (json?.data ?? []).map((m: any) => m.id).filter(Boolean);
      const chat = ids.filter((id) => /^(gpt-|o\d|chatgpt)/i.test(id) && !/(embedding|whisper|tts|audio|image|dall-e|realtime|moderation|transcribe)/i.test(id));
      return chat.length ? chat.sort() : fallback;
    } catch (e) {
      this.log.warn(`openaiModels failed: ${(e as Error).message}`);
      return fallback;
    }
  }

  /** Бесплатные модели OpenRouter (id оканчиваются на ':free'). Список публичный, без ключа. */
  private async openrouterFreeModels(): Promise<string[]> {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(15000) });
      const json: any = await res.json();
      const ids: string[] = (json?.data ?? []).map((m: any) => m.id).filter((id: any) => typeof id === 'string' && id.endsWith(':free'));
      return ids.length ? ids.sort() : OPENROUTER_FREE_FALLBACK;
    } catch (e) {
      this.log.warn(`openrouterFreeModels failed: ${(e as Error).message}`);
      return OPENROUTER_FREE_FALLBACK;
    }
  }
}
