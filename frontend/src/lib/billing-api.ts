import { request } from './api';

/** Оплата подписки (ЮKassa). Отдельно от api.ts: зовут только ленивые экран и плашка. */
export interface BillingPlan { code: string; title: string; price: number; priceYear: number | null; maxMembers: number | null; description: string; perMember?: boolean }
export interface BillingView {
  status: 'TRIAL' | 'ACTIVE' | 'GRACE' | 'READ_ONLY';
  until: string | null;
  writable: boolean;
  complimentary: boolean;
  plan: BillingPlan | null;
  /** За что платили: период и цена продления (не меняются вместе с прайсом). */
  period: 'month' | 'year';
  /** На сколько месяцев оплачен текущий период (1–12). */
  months?: number;
  /** #5000: за сколько пользователей оплачен текущий период (null — за состав на момент оплаты). */
  seats?: number | null;
  lockedPrice: number | null;
  /** Ближайшее продление — по новой цене (перевод владельцем платформы, §5.4). */
  priceChange: { at: string; price: number; nextPeriod: boolean } | null;
  autopay: boolean;
  autopayAvailable: boolean;
  members: number;
  plans: BillingPlan[];
  payments: { id: string; plan: string; amount: number; status: string; kind: string; createdAt: string; paidAt: string | null; periodEnd: string | null; months?: number; test?: boolean }[];
  configured: boolean;
  testMode: boolean;
  /** #4778: пробный период — 14 дней сразу, без условий. */
  trial: { baseDays: number; until: string | null } | null;
  /** «Пригласить команду · +1 мес»: сколько пришло (без владельца), сколько нужно, начислен ли месяц. */
  teamBonus: { need: number; months: number; invited: number; grantedAt: string | null; until: string | null } | null;
}

export const billingApi = {
  view: () => request<BillingView>('GET', '/billing'),
  /** 19.11.2026: срок — 1–12 месяцев; 12 — год со скидкой, остальное — цена месяца × месяцы. */
  checkout: (plan: string, months = 1, seats?: number) => request<{ confirmationUrl: string; paymentId: string }>('POST', '/billing/checkout', { plan, months, seats, period: months === 12 ? 'year' : 'month' }),
  check: (paymentId: string) => request<{ status: string }>('POST', `/billing/payments/${paymentId}/check`, {}),
  /** #5001: отменить неоплаченный счёт, чтобы выставить новый. */
  cancelPayment: (paymentId: string) => request<BillingView>('POST', `/billing/payments/${paymentId}/cancel`, {}),
  autopay: (on: boolean) => request<BillingView>('POST', '/billing/autopay', { on }),
};

/** Цена за срок — так же, как считает сервер (billing-rules.periodPrice). */
export function periodPrice(month: number, year: number | null, months: number): number {
  return months === 12 && year != null ? year : month * months;
}

/** «1 месяц», «3 месяца», «5 месяцев», «1 год». */
export function periodLabel(months: number): string {
  if (months === 12) return '1 год';
  const a = months % 100; const b = months % 10;
  return `${months} ${a > 10 && a < 20 ? 'месяцев' : b === 1 ? 'месяц' : b >= 2 && b <= 4 ? 'месяца' : 'месяцев'}`;
}
