/**
 * Тарифы ИИ (ТЗ-33) — чистые правила, без базы.
 *
 * Главный принцип ТЗ: тарифы различаются не кнопкой в интерфейсе, а набором
 * возможностей, который сервер выдаёт модели. Здесь решается, что организации
 * можно, — остальной код спрашивает не «какой тариф», а «можно ли web_search».
 */

export type PlanCode = 'AI_BASIC' | 'AI_EXTENDED';
export type PlanStatus = 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'CANCELLED';

export const CAPABILITIES = [
  'ai.internal', 'ai.voice', 'ai.meeting', 'ai.second_brain',
  'ai.web_search', 'ai.web_fetch', 'ai.website_parse', 'ai.external_research',
] as const;
export type Capability = typeof CAPABILITIES[number];
export type Capabilities = Record<Capability, boolean>;

const WEB: Capability[] = ['ai.web_search', 'ai.web_fetch', 'ai.website_parse', 'ai.external_research'];

/** Пробный «Расширенный» для новых (решение 15.10): 14 дней и маленький жёсткий лимит. */
export const TRIAL_DAYS = 14;
export const TRIAL_WEB_CREDITS = 50;
/** Месячный запас «Расширенного» по умолчанию — вендор меняет в консоли. */
export const EXTENDED_WEB_CREDITS = 300;
/** Пороги предупреждения владельцу (§33). */
export const THRESHOLDS = [50, 80, 100] as const;

export interface PlanRow {
  plan_code: PlanCode;
  status: PlanStatus;
  started_at: Date;
  trial_ends_at: Date | null;
  included_web_credits: number;
  hard_limit_enabled: boolean;
}

/**
 * Действующий тариф с учётом статуса.
 *
 * Кончился пробный, просрочен платёж, приостановлен, отменён — интернет выключается,
 * а ИИ внутри CRM продолжает работать (§34, §56): из-за денег на поиск нельзя
 * ломать всю систему. Тарифа нет вовсе (новая организация ещё не выбрала) — как
 * «Базовый»: внутри CRM всё работает и до выбора.
 */
export function effectivePlan(row: PlanRow | null, now = new Date()): { plan: PlanCode; webActive: boolean; trialExpired: boolean } {
  if (!row) return { plan: 'AI_BASIC', webActive: false, trialExpired: false };
  const trialExpired = row.status === 'TRIAL' && !!row.trial_ends_at && row.trial_ends_at.getTime() <= now.getTime();
  const live = row.status === 'ACTIVE' || (row.status === 'TRIAL' && !trialExpired);
  return { plan: row.plan_code, webActive: row.plan_code === 'AI_EXTENDED' && live, trialExpired };
}

export function capabilitiesOf(row: PlanRow | null, now = new Date()): Capabilities {
  const { webActive } = effectivePlan(row, now);
  const out = Object.fromEntries(CAPABILITIES.map((c) => [c, true])) as Capabilities;
  for (const c of WEB) out[c] = webActive;
  return out;
}

/**
 * Период учёта веб-кредитов.
 *
 * Пробный — весь пробный срок целиком (50 запросов на 14 дней, а не на месяц).
 * Обычный — календарный месяц по UTC: просто сверять со счётом и понятно человеку.
 */
export function periodOf(row: PlanRow | null, now = new Date()): { start: Date; end: Date; key: string } {
  if (row?.status === 'TRIAL' && row.trial_ends_at) {
    return { start: row.started_at, end: row.trial_ends_at, key: `trial:${row.started_at.toISOString().slice(0, 10)}` };
  }
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end, key: start.toISOString().slice(0, 7) };
}

/** Хватит ли кредитов на ещё `need` (с учётом уже зарезервированных параллельными запросами). */
export function canSpend(i: { used: number; reserved: number; limit: number; need: number; hardLimit: boolean }): boolean {
  if (!i.hardLimit) return true;
  return i.used + i.reserved + i.need <= i.limit;
}

/** Какой порог впервые перешли этим расходом — о нём и сказать владельцу (один раз за период). */
export function crossedThreshold(used: number, limit: number, alreadyNotified: number): number | null {
  if (limit <= 0) return null;
  const pct = (used / limit) * 100;
  const hit = [...THRESHOLDS].reverse().find((t) => pct >= t);
  return hit && hit > alreadyNotified ? hit : null;
}

/** Строка про исчерпание для человека и модели — одна на все места. */
export const PLAN_TITLE: Record<PlanCode, string> = { AI_BASIC: 'Базовый', AI_EXTENDED: 'Расширенный' };

/**
 * Почему интернета нет — для модели (§7, §18): она должна не «ничего не нашла»,
 * а честно сказать, что это в другом тарифе. Сам запрет — в наборе инструментов,
 * это только объяснение.
 */
export function webUnavailableNote(reason: 'plan' | 'trial_expired' | 'suspended' | 'limit' | 'role' | 'off' | 'no_key'): string {
  switch (reason) {
    case 'plan': return 'Интернет недоступен: тариф «Базовый» — ИИ работает только с данными QEVO. Если человек просит открыть сайт, найти в интернете или изучить внешнюю компанию — скажи, что это есть в тарифе «Расширенный» (Настройки → Тариф и ИИ). Ссылку можно разобрать только как текст или попросить загрузить файл.';
    case 'trial_expired': return 'Интернет недоступен: пробный период «Расширенного» закончился, сейчас ИИ работает только с данными QEVO. Продлить — Настройки → Тариф и ИИ.';
    case 'suspended': return 'Интернет временно недоступен по тарифу организации; ИИ работает с данными QEVO.';
    case 'limit': return 'Интернет недоступен: в этом месяце исчерпан лимит интернет-запросов организации. ИИ по данным QEVO работает как обычно. Лимит — Настройки → Тариф и ИИ.';
    case 'role': return 'Интернет недоступен этому сотруднику: владелец не разрешил его роли. Отвечай по данным QEVO.';
    case 'off': return 'Интернет для бота выключен владельцем в настройках QEVO Bot. Отвечай по данным QEVO.';
    case 'no_key': return 'Интернет-поиск не настроен на сервере. Отвечай по данным QEVO.';
  }
}

/**
 * Перед поисковым запросом — убрать то, что не должно уйти наружу (§46): почты,
 * телефоны, похожее на ключи и токены, длинные номера. Поиск — это ЧИТАТЬ интернет,
 * а не публиковать в нём данные CRM.
 */
export function scrubQuery(q: string): string {
  return q
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, ' ')
    .replace(/\b(?:sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{8,}\b/g, ' ')
    .replace(/\b[A-Fa-f0-9]{24,}\b/g, ' ')
    .replace(/\+?\d[\d\s()-]{8,}\d/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
