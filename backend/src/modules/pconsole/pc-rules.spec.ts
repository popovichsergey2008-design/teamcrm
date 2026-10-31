import { canEnter, deltaPct, periodOf, permsFor, safeTz } from './pc-rules';

describe('консоли платформы: права', () => {
  it('доступ в одну консоль не даёт другие', () => {
    expect(canEnter(['developer'], 'owner')).toBe(false);
    expect(permsFor(['developer'], 'owner')).toEqual([]);
    expect(permsFor(['developer'], 'developer')).toEqual(['dev.view']);
  });
  it('раздавать роли может только владелец', () => {
    expect(permsFor(['owner'], 'owner')).toContain('staff.manage');
    expect(permsFor(['owner', 'developer'], 'developer')).not.toContain('staff.manage');
  });
});

describe('консоли платформы: период', () => {
  const now = new Date('2026-10-31T22:30:00Z'); // в Москве уже 1 ноября, 01:30
  it('сегодня — по отчётному поясу', () => {
    expect(periodOf('today', 'Europe/Moscow', now)).toMatchObject({ from: '2026-11-01', to: '2026-11-02', prevFrom: '2026-10-31', days: 1 });
    expect(periodOf('today', 'UTC', now)).toMatchObject({ from: '2026-10-31', to: '2026-11-01' });
  });
  it('прошлый месяц и равный период до него', () => {
    expect(periodOf('prev_month', 'Europe/Moscow', now)).toMatchObject({ from: '2026-10-01', to: '2026-11-01', days: 31, prevFrom: '2026-08-31' });
  });
  it('свой диапазон включает последний день', () => {
    expect(periodOf('custom', 'UTC', now, { from: '2026-10-01', to: '2026-10-10' })).toMatchObject({ from: '2026-10-01', to: '2026-10-11', days: 10 });
    expect(() => periodOf('custom', 'UTC', now, { from: '2026-10-10', to: '2026-10-01' })).toThrow();
    expect(() => periodOf('custom', 'UTC', now, { from: 'x', to: '2026-10-01' })).toThrow();
  });
  it('пояс и проценты', () => {
    expect(safeTz('Mars/Base')).toBe('Europe/Moscow');
    expect(safeTz('Asia/Novosibirsk')).toBe('Asia/Novosibirsk');
    expect(deltaPct(15, 10)).toBe(50);
    expect(deltaPct(5, 0)).toBeNull();
  });
});
