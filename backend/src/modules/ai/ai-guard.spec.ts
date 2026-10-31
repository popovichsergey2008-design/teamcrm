import { AI_GUARD_DEFAULT, decide, normalizeGuard } from './ai-guard';

describe('выключатели и бюджет общего ИИ', () => {
  it('по умолчанию всё разрешено', () => {
    expect(decide(AI_GUARD_DEFAULT, 1000)).toEqual({ any: true, shared: true, reason: null });
  });
  it('весь ИИ выключен — и общий ключ тоже', () => {
    expect(decide({ ...AI_GUARD_DEFAULT, allOff: true, allReason: 'авария' }, 0)).toEqual({ any: false, shared: false, reason: 'авария' });
  });
  it('общий ключ выключен — свои ключи компаний работают', () => {
    expect(decide({ ...AI_GUARD_DEFAULT, sharedOff: true }, 0)).toMatchObject({ any: true, shared: false });
  });
  it('бюджет исчерпан — общий ключ закрыт, остальное работает', () => {
    const cfg = { ...AI_GUARD_DEFAULT, monthlyBudgetUsd: 50 };
    expect(decide(cfg, 49.99).shared).toBe(true);
    expect(decide(cfg, 50)).toMatchObject({ any: true, shared: false });
    expect(decide({ ...cfg, monthlyBudgetUsd: 0 }, 0).shared).toBe(false);
  });
  it('мусор в настройке не ломает и не открывает лишнего', () => {
    expect(normalizeGuard(null)).toEqual(AI_GUARD_DEFAULT);
    expect(normalizeGuard({ allOff: 'yes', monthlyBudgetUsd: -5 })).toEqual(AI_GUARD_DEFAULT);
    expect(normalizeGuard({ sharedOff: true, monthlyBudgetUsd: '20' })).toMatchObject({ sharedOff: true, monthlyBudgetUsd: 20 });
  });
});
