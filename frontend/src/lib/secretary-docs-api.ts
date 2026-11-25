import { api, request } from './api';

/**
 * #1476 — функции секретаря: сроки документов, проверка договора, чеки, даты клиентов.
 * Отдельный файл: подключается только ленивыми экранами, первый экран не тяжелеет.
 */

export type DocKind = 'passport' | 'visa' | 'insurance' | 'contract' | 'license' | 'other';
export const DOC_KIND_LABEL: Record<DocKind, string> = {
  passport: 'Паспорт', visa: 'Виза', insurance: 'Страховой полис', contract: 'Договор', license: 'Лицензия / разрешение', other: 'Другой документ',
};
export interface DocDeadline {
  id: string; kind: DocKind; title: string; expiresOn: string; remindDays: number[]; note: string | null; renewedAt: string | null; createdAt: string;
}

export type RiskLevel = 'high' | 'medium' | 'low';
export interface ContractRisk { level: RiskLevel; topic: string; quote: string; why: string; fix: string; source: 'rules' | 'ai' }
export interface ContractReview {
  summary: string; parties: string[]; subject: string | null; amount: string | null; term: string | null;
  risks: ContractRisk[]; missing: string[]; rulesOnly: boolean; fileName: string; checkedAt: string; cached: boolean;
}

export const RECEIPT_CATEGORY_LABEL: Record<string, string> = {
  taxi: 'Такси', transport: 'Билеты и транспорт', hotel: 'Проживание', food: 'Питание', office: 'Канцелярия и офис',
  fuel: 'Топливо', communication: 'Связь и интернет', other: 'Прочее',
};
export interface Receipt {
  id: string; fileId: string | null; fileName: string | null; contentType: string | null; status: 'new' | 'recognized' | 'failed' | 'manual';
  spentOn: string | null; seller: string | null; sellerInn: string | null; total: number | null; vat: number | null; currency: string;
  category: string; purpose: string | null; error: string | null; createdAt: string;
}

export type ClientDateKind = 'birthday' | 'company' | 'partnership' | 'other';
export const CLIENT_DATE_LABEL: Record<ClientDateKind, string> = {
  birthday: 'День рождения', company: 'День компании', partnership: 'Начало сотрудничества', other: 'Другая дата',
};
export interface ClientDate { id: string; kind: ClientDateKind; title: string | null; month: number; day: number; year: number | null; contactId: string | null; person: string | null }

const q = (from?: string, to?: string) => {
  const p = new URLSearchParams();
  if (from) p.set('from', from);
  if (to) p.set('to', to);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const docsApi = {
  list: () => request<DocDeadline[]>('GET', '/doc-deadlines'),
  add: (v: { kind: DocKind; title: string; expiresOn: string; remindDays?: number[]; note?: string | null }) => request<DocDeadline>('POST', '/doc-deadlines', v),
  update: (id: string, v: Partial<{ kind: DocKind; title: string; expiresOn: string; remindDays: number[]; note: string | null; renewed: boolean }>) =>
    request<DocDeadline>('PATCH', `/doc-deadlines/${id}`, v),
  remove: (id: string) => request<{ removed: boolean }>('DELETE', `/doc-deadlines/${id}`),

  contract: (fileId: string, force = false) => request<ContractReview>('POST', `/contract-review/${fileId}${force ? '?force=1' : ''}`),

  receipts: (from?: string, to?: string) => request<Receipt[]>('GET', `/receipts${q(from, to)}`),
  addReceiptFile: async (file: File) => {
    const f = await api.uploadFile(file, 'receipt');
    return request<Receipt>('POST', '/receipts', { fileId: f.id });
  },
  addReceiptManual: () => request<Receipt>('POST', '/receipts', {}),
  recognize: (id: string) => request<Receipt>('POST', `/receipts/${id}/recognize`),
  updateReceipt: (id: string, v: Partial<Pick<Receipt, 'spentOn' | 'seller' | 'sellerInn' | 'currency' | 'category' | 'purpose'>> & { total?: number | string | null; vat?: number | string | null }) =>
    request<Receipt>('PATCH', `/receipts/${id}`, v),
  removeReceipt: (id: string) => request<{ removed: boolean }>('DELETE', `/receipts/${id}`),
  exportReceipts: async (from?: string, to?: string) => {
    const blob = await api.authedBlob(`/api/receipts/export${q(from, to)}`);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `Авансовый отчёт ${[from, to].filter(Boolean).join(' — ') || new Date().toISOString().slice(0, 10)}.xlsx`; a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  },

  clientDates: (clientId: string) => request<ClientDate[]>('GET', `/clients/${clientId}/dates`),
  addClientDate: (clientId: string, v: { kind: ClientDateKind; contactId?: string | null; title?: string | null; month: number; day: number; year?: number | null }) =>
    request<ClientDate[]>('POST', `/clients/${clientId}/dates`, v),
  removeClientDate: (id: string) => request<ClientDate[]>('DELETE', `/client-dates/${id}`),
};

/** «через 12 дней», «завтра», «сегодня», «истёк 3 дня назад» — по местной дате. */
export function leftWords(iso: string): { text: string; tone: 'over' | 'soon' | 'ok' } {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(`${iso}T00:00:00`);
  const days = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  const pl = (n: number) => { const m10 = n % 10; const m100 = n % 100; return m10 === 1 && m100 !== 11 ? 'день' : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? 'дня' : 'дней'; };
  if (days < 0) return { text: `истёк ${-days} ${pl(-days)} назад`, tone: 'over' };
  if (days === 0) return { text: 'истекает сегодня', tone: 'over' };
  if (days === 1) return { text: 'истекает завтра', tone: 'soon' };
  return { text: `через ${days} ${pl(days)}`, tone: days <= 30 ? 'soon' : 'ok' };
}
