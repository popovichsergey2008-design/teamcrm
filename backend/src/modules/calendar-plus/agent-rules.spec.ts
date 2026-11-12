import { parseAgent } from './agent-rules';

// пятница, 13 ноября 2026, 9:00
const now = new Date(2026, 10, 13, 9, 0);

describe('#4892 п. 13: команды агенту календаря', () => {
  it('перенеси все мои встречи завтра после 15:00 на пятницу, мне к врачу', () => {
    const i = parseAgent('Перенеси все мои встречи завтра после 15:00 на пятницу, мне к врачу', now);
    expect(i?.kind).toBe('move');
    if (i?.kind !== 'move') return;
    expect(i.day.getDate()).toBe(14);
    expect(i.after).toBe(15 * 60);
    expect(i.target.getDate()).toBe(20);
    expect(i.reason).toBe('мне к врачу');
  });
  it('найди час с Глебом на этой неделе', () => {
    const i = parseAgent('найди час с Глебом на этой неделе', now);
    expect(i).toEqual({ kind: 'find', minutes: 60, scope: 'week', day: null });
  });
  it('освободи мне утро четверга', () => {
    const i = parseAgent('освободи мне утро четверга', now);
    expect(i?.kind).toBe('free');
    if (i?.kind === 'free') { expect(i.part).toBe('morning'); expect(i.day.getDate()).toBe(19); }
  });
  it('что у меня завтра?', () => {
    const i = parseAgent('что у меня завтра?', now);
    expect(i?.kind).toBe('summary');
    if (i?.kind === 'summary') expect(i.day.getDate()).toBe(14);
  });
  it('задачи не путаются со встречами', () => {
    expect(parseAgent('перенеси задачу на завтра', now)).toBeNull();
    expect(parseAgent('что у меня по задачам', now)).toBeNull();
  });
});
