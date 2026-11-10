/**
 * Подписка компании: чистые правила (без базы и ЮKassa) — их проверяют юнит-тесты.
 *
 * Решение заказчика 30.10: платит компания помесячно; 14 дней пробного периода без карты;
 * не оплатили — 3 дня льготы, потом «только чтение»; данные не удаляются.
 */
export const TRIAL_DAYS = 14;
export const GRACE_DAYS = 3;
/** «Пригласить команду · +1 мес»: столько участников кроме владельца — и месяц в подарок, один раз. */
export const TEAM_BONUS_INVITES = 6;
export const TEAM_BONUS_MONTHS = 1;
export const PERIOD_MONTHS = 1;
const DAY = 86_400_000;

export type SubStatus = 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'READ_ONLY' | 'CANCELLED';

export interface SubRow {
  status: SubStatus;
  plan_code: string | null;
  trial_ends_at: Date | null;
  current_period_end: Date | null;
  complimentary: boolean;
}

export interface Effective {
  /** Что видит человек: пробный, оплачено, просрочено (льгота), только чтение. */
  status: 'TRIAL' | 'ACTIVE' | 'GRACE' | 'READ_ONLY';
  /** Когда кончится то, что сейчас действует (пробный, оплаченный период, льгота). */
  until: Date | null;
  /** Писать можно — всё, кроме «только чтения». */
  writable: boolean;
  complimentary: boolean;
}

/**
 * Действующее состояние на момент `now`. Строки может не быть (новая компания) —
 * тогда пробный период от создания компании. Площадка вендора — всегда без ограничений.
 */
export function effective(row: SubRow | null, tenantCreatedAt: Date, now: Date, isPlatform = false): Effective {
  if (isPlatform || row?.complimentary) return { status: 'ACTIVE', until: null, writable: true, complimentary: true };
  // оплаченный период ещё идёт — неважно, что было до него
  const paidEnd = row?.current_period_end ? new Date(row.current_period_end) : null;
  if (paidEnd && paidEnd > now) return { status: 'ACTIVE', until: paidEnd, writable: true, complimentary: false };
  if (paidEnd) return afterEnd(paidEnd, now);
  const trialEnd = row?.trial_ends_at ? new Date(row.trial_ends_at) : new Date(tenantCreatedAt.getTime() + TRIAL_DAYS * DAY);
  if (trialEnd > now) return { status: 'TRIAL', until: trialEnd, writable: true, complimentary: false };
  return afterEnd(trialEnd, now);
}

function afterEnd(end: Date, now: Date): Effective {
  const graceEnd = new Date(end.getTime() + GRACE_DAYS * DAY);
  if (graceEnd > now) return { status: 'GRACE', until: graceEnd, writable: true, complimentary: false };
  return { status: 'READ_ONLY', until: null, writable: false, complimentary: false };
}

/** Новый конец оплаченного периода: продление от конца текущего, если он ещё не прошёл. */
export function extendPeriod(currentEnd: Date | null, now: Date, months = PERIOD_MONTHS): Date {
  const from = currentEnd && currentEnd > now ? new Date(currentEnd) : new Date(now);
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

/** Сумма для ЮKassa: строка с двумя знаками («990.00»). */
export const amountValue = (rub: number | string): string => Number(rub).toFixed(2);

/**
 * Что сказать владельцу сейчас (один раз на событие): ключ уведомления или null.
 * `notified` — уже отправленные ключи.
 */
export function noticeDue(eff: Effective, notified: Record<string, unknown>, now: Date, periodKey: string): string | null {
  const daysLeft = eff.until ? (eff.until.getTime() - now.getTime()) / DAY : null;
  let key: string | null = null;
  if (eff.status === 'TRIAL' && daysLeft !== null && daysLeft <= 1) key = 'trial_1d';
  else if (eff.status === 'TRIAL' && daysLeft !== null && daysLeft <= 3) key = 'trial_3d';
  else if (eff.status === 'ACTIVE' && !eff.complimentary && daysLeft !== null && daysLeft <= 3) key = 'renew_3d';
  else if (eff.status === 'GRACE') key = 'grace';
  else if (eff.status === 'READ_ONLY') key = 'read_only';
  if (!key) return null;
  const full = `${key}:${periodKey}`;
  return notified[full] ? null : full;
}

/** Запросы, которые проходят и в «только чтении»: вход, оплата, профиль, поддержка. */
export function allowedWhenReadOnly(method: string, path: string): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  const p = path.split('?')[0];
  return ['/api/auth/', '/api/billing', '/api/support', '/api/legal', '/api/csp-report', '/api/mobile/devices']
    .some((prefix) => p.startsWith(prefix));
}

// ── Перевод действующих подписок на новую цену (§5.4, 0225) ──

export interface PriceMove {
  id: string; plan_code: string; to_version: number;
  price_month_rub: string; price_year_rub: string | null; apply_from: string;
}

/** Сколько дней до списания письмо о новой цене должно уже лежать у владельца. */
export const MOVE_NOTICE_DAYS = 14;

/**
 * Какой перевод касается продления этой подписки в periodEnd: тариф тот же, версия
 * новее оплаченной, дата продления не раньше даты перевода. Годовую подписку переводим
 * только если у новой версии есть цена за год. Из нескольких — самый свежий.
 */
export function moveFor(
  sub: { plan_code: string | null; plan_version: number | null; period_months: number },
  periodEnd: Date, moves: PriceMove[],
): PriceMove | null {
  const at = periodEnd.toISOString().slice(0, 10);
  const year = sub.period_months === 12;
  const fit = moves.filter((m) => m.plan_code === sub.plan_code
    && (sub.plan_version == null || m.to_version > sub.plan_version)
    && at >= m.apply_from && (!year || m.price_year_rub != null));
  return fit.sort((a, b) => b.to_version - a.to_version || Number(b.id) - Number(a.id))[0] ?? null;
}

export const movePrice = (m: PriceMove, months: number): number => Number(months === 12 ? m.price_year_rub : m.price_month_rub);

/** Новую цену списываем, только если о ней сказали заранее; иначе — ещё период по прежней. */
export function moveReady(notifiedAt: unknown, periodEnd: Date): boolean {
  const t = typeof notifiedAt === 'string' ? Date.parse(notifiedAt) : NaN;
  return Number.isFinite(t) && periodEnd.getTime() - t >= MOVE_NOTICE_DAYS * DAY;
}

export const moveKey = (id: string) => `price_move:${id}`;
