import { aiState, AiFacts } from './pc-support-rules';

const on = { any: true, shared: true, reason: null };
const base: AiFacts = { own: false, guard: on, trial: null };
const trial = (t: Partial<NonNullable<AiFacts['trial']>>): AiFacts['trial'] =>
  ({ allowed: true, reason: 'trial', endsAt: new Date('2026-11-15T12:00:00Z'), tokensUsed: 250_000, tokensLimit: 1_000_000, ...t });

describe('aiState — ИИ клиента словами для оператора', () => {
  it('выключатель платформы сильнее своего ключа', () => {
    expect(aiState({ ...base, own: true, guard: { any: false, shared: false, reason: 'авария у провайдера' } }))
      .toEqual({ state: 'off', text: 'ИИ выключен на всей платформе: авария у провайдера' });
  });

  it('свой ключ — работает, лимиты у провайдера', () => {
    expect(aiState({ ...base, own: true }).state).toBe('own');
  });

  it('общий ключ выключен владельцем — причина видна', () => {
    const s = aiState({ ...base, guard: { any: true, shared: false, reason: 'потолок месяца' }, trial: trial({}) });
    expect(s.state).toBe('off');
    expect(s.text).toContain('потолок месяца');
  });

  it('пробный: остаток токенов и дата', () => {
    const s = aiState({ ...base, trial: trial({}) });
    expect(s.state).toBe('trial');
    expect(s.text).toContain('15 ноября');
    expect(s.text).toContain('750');
  });

  it('пробный закончился или токены вышли — отказ с причиной', () => {
    expect(aiState({ ...base, trial: trial({ allowed: false, reason: 'expired' }) }).text).toContain('закончился');
    expect(aiState({ ...base, trial: trial({ allowed: false, reason: 'exhausted', tokensUsed: 1_000_000 }) }).text).toContain('израсходованы');
  });

  it('ни своего, ни общего ключа', () => {
    expect(aiState(base)).toEqual({ state: 'off', text: 'Своего ключа нет, общего ключа на сервере нет' });
  });
});
