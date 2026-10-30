import { allowedWhenReadOnly, amountValue, effective, extendPeriod, noticeDue, SubRow } from './billing-rules';

const day = 86_400_000;
const now = new Date('2026-10-30T12:00:00Z');
const ago = (d: number) => new Date(now.getTime() - d * day);
const later = (d: number) => new Date(now.getTime() + d * day);
const row = (p: Partial<SubRow>): SubRow => ({ status: 'TRIAL', plan_code: null, trial_ends_at: null, current_period_end: null, complimentary: false, ...p });

describe('подписка: действующее состояние', () => {
  it('новая компания без строки — 14 дней пробного', () => {
    const e = effective(null, ago(3), now);
    expect(e.status).toBe('TRIAL');
    expect(e.until!.getTime()).toBe(ago(3).getTime() + 14 * day);
  });
  it('пробный кончился — 3 дня льготы, потом только чтение', () => {
    expect(effective(null, ago(15), now)).toMatchObject({ status: 'GRACE', writable: true });
    expect(effective(null, ago(18), now)).toMatchObject({ status: 'READ_ONLY', writable: false });
  });
  it('оплаченный период важнее пробного', () => {
    expect(effective(row({ current_period_end: later(10) }), ago(100), now)).toMatchObject({ status: 'ACTIVE', writable: true });
    expect(effective(row({ current_period_end: ago(1) }), ago(100), now).status).toBe('GRACE');
    expect(effective(row({ current_period_end: ago(4) }), ago(100), now).status).toBe('READ_ONLY');
  });
  it('«вечные» и площадка — без ограничений', () => {
    expect(effective(row({ complimentary: true }), ago(900), now)).toMatchObject({ status: 'ACTIVE', complimentary: true });
    expect(effective(null, ago(900), now, true).writable).toBe(true);
  });
  it('продление пробного вендором', () => {
    expect(effective(row({ trial_ends_at: later(5) }), ago(60), now).status).toBe('TRIAL');
  });
});

describe('подписка: деньги и сроки', () => {
  it('продление от конца текущего периода, если он не прошёл', () => {
    expect(extendPeriod(later(5), now).toISOString().slice(0, 10)).toBe('2026-12-04');
    expect(extendPeriod(ago(5), now).toISOString().slice(0, 10)).toBe('2026-11-30');
    expect(extendPeriod(null, now).toISOString().slice(0, 10)).toBe('2026-11-30');
  });
  it('сумма для ЮKassa', () => {
    expect(amountValue('990')).toBe('990.00');
    expect(amountValue(1234.5)).toBe('1234.50');
  });
  it('уведомления — по одному на событие', () => {
    const e = effective(null, ago(12), now);
    const key = noticeDue(e, {}, now, 'p1');
    expect(key).toBe('trial_3d:p1');
    expect(noticeDue(e, { [key!]: true }, now, 'p1')).toBeNull();
    expect(noticeDue(effective(null, ago(20), now), {}, now, 'p1')).toBe('read_only:p1');
    expect(noticeDue(effective(row({ complimentary: true }), ago(1), now), {}, now, 'p')).toBeNull();
  });
  it('в «только чтении» проходят вход, оплата и поддержка', () => {
    expect(allowedWhenReadOnly('GET', '/api/projects')).toBe(true);
    expect(allowedWhenReadOnly('POST', '/api/billing/checkout')).toBe(true);
    expect(allowedWhenReadOnly('POST', '/api/auth/login')).toBe(true);
    expect(allowedWhenReadOnly('POST', '/api/tasks')).toBe(false);
  });
});
