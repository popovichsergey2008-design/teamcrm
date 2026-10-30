/**
 * Пробный ИИ общим ключом сервера (#4624, созвон 21.10: «для новых пользователей ИИ не
 * активен — не решили, сколько токенов выделяем на пробную версию»).
 *
 * Общий ключ (KIMI_API_KEY / OPENAI_API_KEY в .env) раньше доставался ВСЕМ организациям
 * без своего ключа и без счёта — поэтому его на сервере и не держали, и у новых людей ИИ
 * молчал. Теперь общий ключ — только:
 *   - площадке вендора (is_platform) — без потолка;
 *   - новой организации: TRIAL_DAYS с регистрации и не больше TRIAL_TOKENS токенов.
 *     Вендор продлевает пробный период из консоли (тариф со статусом TRIAL) — тогда окно
 *     и счёт идут от его начала.
 * Свой ключ организации — всегда её и без этих правил.
 *
 * Цифра по умолчанию: команда QEVO за неделю на Kimi израсходовала ~560 тыс. токенов
 * ($2,5). 1 млн на две недели одной новой компании — с запасом на знакомство, около $5.
 */
export const TRIAL_DAYS_DEFAULT = 14;
export const TRIAL_TOKENS_DEFAULT = 1_000_000;

export interface TrialFacts {
  isPlatform: boolean;
  tenantCreatedAt: Date;
  /** Тариф ИИ со статусом TRIAL (продление вендором): начало и конец. */
  planTrial: { startedAt: Date; endsAt: Date } | null;
  /** Токены ИИ компании с начала окна. */
  tokensUsed: number;
}

export interface TrialVerdict {
  allowed: boolean;
  /** platform — без потолка; trial — в пределах; expired — срок вышел; exhausted — токены кончились. */
  reason: 'platform' | 'trial' | 'expired' | 'exhausted';
  windowStart: Date;
  endsAt: Date | null;
  tokensUsed: number;
  tokensLimit: number | null;
}

export function trialVerdict(f: TrialFacts, now: Date, days = TRIAL_DAYS_DEFAULT, limit = TRIAL_TOKENS_DEFAULT): TrialVerdict {
  if (f.isPlatform) {
    return { allowed: true, reason: 'platform', windowStart: f.tenantCreatedAt, endsAt: null, tokensUsed: f.tokensUsed, tokensLimit: null };
  }
  const ownEnd = new Date(f.tenantCreatedAt.getTime() + days * 86_400_000);
  // продление вендором — если оно дальше собственного окна
  const extended = f.planTrial && f.planTrial.endsAt > ownEnd ? f.planTrial : null;
  const windowStart = extended ? extended.startedAt : f.tenantCreatedAt;
  const endsAt = extended ? extended.endsAt : ownEnd;
  const base = { windowStart, endsAt, tokensUsed: f.tokensUsed, tokensLimit: limit };
  if (now >= endsAt) return { ...base, allowed: false, reason: 'expired' };
  if (f.tokensUsed >= limit) return { ...base, allowed: false, reason: 'exhausted' };
  return { ...base, allowed: true, reason: 'trial' };
}
