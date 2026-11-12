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
  checkout: (plan: string, period: 'month' | 'year' = 'month') => request<{ confirmationUrl: string; paymentId: string }>('POST', '/billing/checkout', { plan, period }),
  check: (paymentId: string) => request<{ status: string }>('POST', `/billing/payments/${paymentId}/check`, {}),
  autopay: (on: boolean) => request<BillingView>('POST', '/billing/autopay', { on }),
};
