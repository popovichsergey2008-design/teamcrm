import { randomUUID } from 'crypto';

/**
 * ЮKassa, API v3 — только то, что нужно подписке: создать платёж и узнать его состояние.
 *
 * Отдельным классом (адаптер), а не вперемешку с подпиской: мастер-план просит не
 * привязывать CRM к одному провайдеру — другой подключается своим адаптером с тем же видом.
 * Ключи — только из окружения (YOOKASSA_SHOP_ID, YOOKASSA_SECRET_KEY), не в коде и не в git.
 */
export interface ProviderPayment {
  id: string;
  status: 'pending' | 'waiting_for_capture' | 'succeeded' | 'canceled';
  amount: { value: string; currency: string };
  paid: boolean;
  metadata?: Record<string, string>;
  confirmation?: { type: string; confirmation_url?: string };
  payment_method?: { id: string; saved: boolean; type?: string; title?: string };
  cancellation_details?: { party: string; reason: string };
  test?: boolean;
}

export class YooKassaError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

const API = 'https://api.yookassa.ru/v3';

export class YooKassaClient {
  constructor(private readonly shopId: string, private readonly secretKey: string, private readonly fetchImpl: typeof fetch = fetch) {}

  /** Тестовый магазин: ключ ЮKassa начинается с test_. */
  get testMode(): boolean {
    return this.secretKey.startsWith('test_');
  }

  private headers(idempotenceKey?: string): Record<string, string> {
    return {
      Authorization: `Basic ${Buffer.from(`${this.shopId}:${this.secretKey}`).toString('base64')}`,
      'Content-Type': 'application/json',
      ...(idempotenceKey ? { 'Idempotence-Key': idempotenceKey } : {}),
    };
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, idempotenceKey?: string): Promise<T> {
    const res = await this.fetchImpl(`${API}${path}`, {
      method, headers: this.headers(idempotenceKey), body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new YooKassaError(json?.description ?? `ЮKassa ${res.status}`, res.status, json?.code);
    return json as T;
  }

  /**
   * Платёж с переходом на страницу ЮKassa. Idempotence-Key — наш id платежа: повтор
   * запроса после обрыва связи не создаст второй платёж.
   */
  createRedirect(p: {
    amount: string; description: string; returnUrl: string; metadata: Record<string, string>;
    savePaymentMethod: boolean; idempotenceKey?: string;
  }): Promise<ProviderPayment> {
    return this.call('POST', '/payments', {
      amount: { value: p.amount, currency: 'RUB' },
      capture: true,
      confirmation: { type: 'redirect', return_url: p.returnUrl },
      description: p.description.slice(0, 128),
      metadata: p.metadata,
      ...(p.savePaymentMethod ? { save_payment_method: true } : {}),
    }, p.idempotenceKey ?? randomUUID());
  }

  /** Автопродление сохранённым способом оплаты — без участия человека. */
  createRecurring(p: { amount: string; description: string; paymentMethodId: string; metadata: Record<string, string>; idempotenceKey: string }): Promise<ProviderPayment> {
    return this.call('POST', '/payments', {
      amount: { value: p.amount, currency: 'RUB' },
      capture: true,
      payment_method_id: p.paymentMethodId,
      description: p.description.slice(0, 128),
      metadata: p.metadata,
    }, p.idempotenceKey);
  }

  /**
   * Состояние платежа — источник истины. Уведомления ЮKassa не подписаны, поэтому их
   * содержимому не верим: по id из уведомления спрашиваем платёж у самой ЮKassa.
   */
  get(paymentId: string): Promise<ProviderPayment> {
    return this.call('GET', `/payments/${encodeURIComponent(paymentId)}`);
  }
}
