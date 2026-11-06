/**
 * ИИ общим ключом QEVO (#4624 → #4779, п. 6 и 12).
 *
 * #4779: ИИ работает сразу, без ключа: в тариф входит 1 000 000 токенов в месяц на
 * пространство (хватает на 3–6 человек). Месяц календарный, по Москве: 1-го числа лимит
 * обновляется. Кончился — нужен свой ключ (рекомендуем Kimi), до 1-го числа ИИ общим
 * ключом не работает. Площадке вендора — без потолка. Свой ключ организации — всегда её
 * и без этих правил.
 *
 * Общий ключ — из реестра консоли владельца / .env, а если там пусто — ключи самой
 * площадки (её «Интеграции → ИИ»): иначе у новых пространств ИИ молчал (#4746).
 */
export const TRIAL_DAYS_DEFAULT = 14; // устарело с #4779: срока нет, только месячный лимит
export const TRIAL_TOKENS_DEFAULT = 1_000_000;

export interface TrialFacts {
  isPlatform: boolean;
  tenantCreatedAt: Date;
  /** Тариф ИИ со статусом TRIAL (продление вендором) — с #4779 на лимит не влияет. */
  planTrial: { startedAt: Date; endsAt: Date } | null;
  /** Токены ИИ компании с начала окна (месяца). */
  tokensUsed: number;
}

export interface TrialVerdict {
  allowed: boolean;
  /** platform — без потолка; trial — в пределах месячного лимита; exhausted — лимит месяца кончился; expired — не используется. */
  reason: 'platform' | 'trial' | 'expired' | 'exhausted';
  /** Начало окна счёта — 1-е число месяца по Москве. */
  windowStart: Date;
  /** Когда лимит обновится — 1-е число следующего месяца. */
  endsAt: Date | null;
  tokensUsed: number;
  tokensLimit: number | null;
  /** Прогноз расхода до конца месяца при нынешнем темпе. */
  forecast: number | null;
}

const MSK = 3 * 3600_000;

/** 1-е число месяца по Москве для `now` и следующее за ним. */
export function monthWindow(now: Date): { start: Date; next: Date } {
  const m = new Date(now.getTime() + MSK);
  const start = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), 1) - MSK);
  const next = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1) - MSK);
  return { start, next };
}

/** Прогноз: израсходованное, растянутое на весь месяц по прошедшей доле (не раньше суток). */
export function forecastMonth(used: number, now: Date): number {
  const { start, next } = monthWindow(now);
  const passed = Math.max(86_400_000, now.getTime() - start.getTime());
  return Math.round((used * (next.getTime() - start.getTime())) / passed);
}

// второй параметр (дни) остался от пробных двух недель — вызовы его ещё передают
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function trialVerdict(f: TrialFacts, now: Date, _days = TRIAL_DAYS_DEFAULT, limit = TRIAL_TOKENS_DEFAULT): TrialVerdict {
  const { start, next } = monthWindow(now);
  if (f.isPlatform) {
    return { allowed: true, reason: 'platform', windowStart: start, endsAt: null, tokensUsed: f.tokensUsed, tokensLimit: null, forecast: null };
  }
  const base = { windowStart: start, endsAt: next, tokensUsed: f.tokensUsed, tokensLimit: limit, forecast: forecastMonth(f.tokensUsed, now) };
  if (f.tokensUsed >= limit) return { ...base, allowed: false, reason: 'exhausted' };
  return { ...base, allowed: true, reason: 'trial' };
}

/** Порог предупреждения администратору (#4779, п. 6.6): 80% и 100% лимита месяца. */
export function limitAlert(used: number, limit: number | null): 80 | 100 | null {
  if (!limit) return null;
  if (used >= limit) return 100;
  if (used >= limit * 0.8) return 80;
  return null;
}
