import { YooKassaClient, YooKassaError } from './yookassa.client';

describe('YooKassaClient', () => {
  it('создаёт платёж с переходом: авторизация, ключ идемпотентности, сумма', async () => {
    const calls: { url: string; init: any }[] = [];
    const fake = (async (url: string, init: any) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'p1', status: 'pending', paid: false, amount: { value: '990.00', currency: 'RUB' }, confirmation: { type: 'redirect', confirmation_url: 'https://yoomoney.ru/x' } }) };
    }) as any;
    const k = new YooKassaClient('1512844', 'test_secret', fake);
    expect(k.testMode).toBe(true);
    const p = await k.createRedirect({ amount: '990.00', description: 'QEVO', returnUrl: 'https://app/x', metadata: { a: '1' }, savePaymentMethod: false, idempotenceKey: 'k1' });
    expect(p.confirmation?.confirmation_url).toBe('https://yoomoney.ru/x');
    expect(calls[0].url).toBe('https://api.yookassa.ru/v3/payments');
    expect(calls[0].init.headers.Authorization).toBe(`Basic ${Buffer.from('1512844:test_secret').toString('base64')}`);
    expect(calls[0].init.headers['Idempotence-Key']).toBe('k1');
    const body = JSON.parse(calls[0].init.body);
    expect(body).toMatchObject({ amount: { value: '990.00', currency: 'RUB' }, capture: true, confirmation: { type: 'redirect' } });
    expect(body.save_payment_method).toBeUndefined();
  });

  it('ошибка ЮKassa — понятным текстом', async () => {
    const fake = (async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ code: 'invalid_credentials', description: 'Error in shopId or secret key' }) })) as any;
    const err = await new YooKassaClient('1', 'live_x', fake).get('p1').catch((e) => e);
    expect(err).toBeInstanceOf(YooKassaError);
    expect(err.message).toMatch(/shopId/);
  });
});
