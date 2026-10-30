import { request } from './api';

/** Оплата подписки (ЮKassa). Отдельно от api.ts: зовут только ленивые экран и плашка. */
export interface BillingPlan { code: string; title: string; price: number; maxMembers: number | null; description: string }
export interface BillingView {
  status: 'TRIAL' | 'ACTIVE' | 'GRACE' | 'READ_ONLY';
  until: string | null;
  writable: boolean;
  complimentary: boolean;
  plan: BillingPlan | null;
  autopay: boolean;
  autopayAvailable: boolean;
  members: number;
  plans: BillingPlan[];
  payments: { id: string; plan: string; amount: number; status: string; kind: string; createdAt: string; paidAt: string | null; periodEnd: string | null }[];
  configured: boolean;
  testMode: boolean;
}

export const billingApi = {
  view: () => request<BillingView>('GET', '/billing'),
  checkout: (plan: string) => request<{ confirmationUrl: string; paymentId: string }>('POST', '/billing/checkout', { plan }),
  check: (paymentId: string) => request<{ status: string }>('POST', `/billing/payments/${paymentId}/check`, {}),
  autopay: (on: boolean) => request<BillingView>('POST', '/billing/autopay', { on }),
};
