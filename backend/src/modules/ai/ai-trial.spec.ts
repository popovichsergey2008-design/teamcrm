import { forecastMonth, limitAlert, monthWindow, trialVerdict } from './ai-trial';

const now = new Date('2026-11-16T09:00:00Z'); // 16 ноября, 12:00 по Москве

describe('ИИ общим ключом: 1 млн токенов в месяц на пространство (#4779)', () => {
  it('окно — календарный месяц по Москве, лимит обновляется 1-го', () => {
    const { start, next } = monthWindow(now);
    expect(start.toISOString()).toBe('2026-10-31T21:00:00.000Z');
    expect(next.toISOString()).toBe('2026-11-30T21:00:00.000Z');
    const v = trialVerdict({ isPlatform: false, tenantCreatedAt: new Date('2025-01-01'), planTrial: null, tokensUsed: 200_000 }, now);
    expect(v).toMatchObject({ allowed: true, reason: 'trial', tokensLimit: 1_000_000 });
    expect(v.endsAt!.toISOString()).toBe(next.toISOString());
  });

  it('лимит месяца кончился — общим ключом нельзя; срока у пространства нет', () => {
    expect(trialVerdict({ isPlatform: false, tenantCreatedAt: new Date('2024-01-01'), planTrial: null, tokensUsed: 0 }, now).allowed).toBe(true);
    expect(trialVerdict({ isPlatform: false, tenantCreatedAt: now, planTrial: null, tokensUsed: 1_000_000 }, now).reason).toBe('exhausted');
  });

  it('площадка вендора — без потолка', () => {
    const v = trialVerdict({ isPlatform: true, tenantCreatedAt: new Date('2024-01-01'), planTrial: null, tokensUsed: 9e9 }, now);
    expect(v).toMatchObject({ allowed: true, reason: 'platform', tokensLimit: null, endsAt: null });
  });

  it('прогноз до конца месяца и пороги 80/100%', () => {
    // прошло 15,5 из 30 дней — 500 тыс. превращаются примерно в 968 тыс.
    expect(forecastMonth(500_000, now)).toBeGreaterThan(950_000);
    expect(forecastMonth(500_000, now)).toBeLessThan(980_000);
    expect(limitAlert(799_999, 1_000_000)).toBeNull();
    expect(limitAlert(800_000, 1_000_000)).toBe(80);
    expect(limitAlert(1_000_000, 1_000_000)).toBe(100);
  });
});
