import { computeMargin, computeTaskCost, RateVersion, TimeLogInput } from './cost.calculator';

const d = (iso: string) => new Date(iso);

describe('computeTaskCost', () => {
  it('единичный закрытый интервал по одной ставке', () => {
    const logs: TimeLogInput[] = [
      { userId: '1', start: d('2026-01-01T10:00:00Z'), end: d('2026-01-01T12:00:00Z') }, // 2ч
    ];
    const rates: RateVersion[] = [
      { userId: '1', hourlyRate: 100, effectiveFrom: d('2025-01-01T00:00:00Z'), effectiveTo: null },
    ];
    expect(computeTaskCost(logs, rates, d('2026-02-01T00:00:00Z'))).toBe(200);
  });

  it('сумма по нескольким логам и пользователям', () => {
    const logs: TimeLogInput[] = [
      { userId: '1', start: d('2026-01-01T10:00:00Z'), end: d('2026-01-01T11:00:00Z') }, // 1ч * 100
      { userId: '2', start: d('2026-01-01T10:00:00Z'), end: d('2026-01-01T13:00:00Z') }, // 3ч * 50
    ];
    const rates: RateVersion[] = [
      { userId: '1', hourlyRate: 100, effectiveFrom: d('2025-01-01T00:00:00Z'), effectiveTo: null },
      { userId: '2', hourlyRate: 50, effectiveFrom: d('2025-01-01T00:00:00Z'), effectiveTo: null },
    ];
    expect(computeTaskCost(logs, rates, d('2026-02-01T00:00:00Z'))).toBe(250);
  });

  it('интервал через границу смены ставки разбивается по версиям', () => {
    // лог 10:00–14:00 (4ч). ставка 100 до 12:00, затем 200.
    const logs: TimeLogInput[] = [
      { userId: '1', start: d('2026-01-01T10:00:00Z'), end: d('2026-01-01T14:00:00Z') },
    ];
    const rates: RateVersion[] = [
      { userId: '1', hourlyRate: 100, effectiveFrom: d('2025-01-01T00:00:00Z'), effectiveTo: d('2026-01-01T12:00:00Z') },
      { userId: '1', hourlyRate: 200, effectiveFrom: d('2026-01-01T12:00:00Z'), effectiveTo: null },
    ];
    // 2ч*100 + 2ч*200 = 600
    expect(computeTaskCost(logs, rates, d('2026-02-01T00:00:00Z'))).toBe(600);
  });

  it('открытый интервал считается до now (растущая стоимость)', () => {
    const logs: TimeLogInput[] = [
      { userId: '1', start: d('2026-01-01T10:00:00Z'), end: null },
    ];
    const rates: RateVersion[] = [
      { userId: '1', hourlyRate: 60, effectiveFrom: d('2025-01-01T00:00:00Z'), effectiveTo: null },
    ];
    expect(computeTaskCost(logs, rates, d('2026-01-01T10:30:00Z'))).toBe(30); // 0.5ч * 60
  });

  it('время до первой версии ставки не тарифицируется', () => {
    const logs: TimeLogInput[] = [
      { userId: '1', start: d('2026-01-01T08:00:00Z'), end: d('2026-01-01T11:00:00Z') }, // 3ч
    ];
    const rates: RateVersion[] = [
      { userId: '1', hourlyRate: 100, effectiveFrom: d('2026-01-01T10:00:00Z'), effectiveTo: null },
    ];
    expect(computeTaskCost(logs, rates, d('2026-02-01T00:00:00Z'))).toBe(100); // только 10:00–11:00
  });

  it('идемпотентность: один и тот же вход даёт один результат', () => {
    const logs: TimeLogInput[] = [
      { userId: '1', start: d('2026-01-01T10:00:00Z'), end: d('2026-01-01T12:30:00Z') },
    ];
    const rates: RateVersion[] = [
      { userId: '1', hourlyRate: 80, effectiveFrom: d('2025-01-01T00:00:00Z'), effectiveTo: null },
    ];
    const now = d('2026-02-01T00:00:00Z');
    expect(computeTaskCost(logs, rates, now)).toBe(computeTaskCost(logs, rates, now));
  });
});

describe('computeMargin', () => {
  it('маржа = (budget − cost)/budget × 100', () => {
    expect(computeMargin(1000, 200)).toBe(80);
    expect(computeMargin(1000, 900)).toBe(10);
    expect(computeMargin(1000, 1200)).toBe(-20); // убыток
  });
  it('budget null/0 → margin null', () => {
    expect(computeMargin(null, 100)).toBeNull();
    expect(computeMargin(0, 100)).toBeNull();
  });
});
