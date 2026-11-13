import { compareMinutes, peakHour, softStreak } from './habit-rules';

const d = (planned: boolean, off = false) => ({ date: '', planned, off });

describe('мягкая серия дней с планом (#4891, п. 12)', () => {
  it('выходные и отпуск не обнуляют', () => {
    expect(softStreak([d(true), d(false, true), d(false, true), d(true), d(true)])).toBe(3);
  });
  it('один пропуск не обнуляет, два подряд — обнуляют', () => {
    expect(softStreak([d(true), d(false), d(true), d(true)])).toBe(3);
    expect(softStreak([d(true), d(false), d(false), d(true), d(true)])).toBe(1);
  });
  it('сегодня ещё без плана — не пропуск', () => {
    expect(softStreak([d(false), d(true), d(true)])).toBe(2);
  });
});

describe('итоги недели', () => {
  it('пиковый час и сравнение', () => {
    expect(peakHour({ 9: 30, 10: 90, 15: 40 })).toBe(10);
    expect(peakHour({})).toBeNull();
    const f = (m: number) => `${m} мин`;
    expect(compareMinutes(200, 120, f)).toBe('+80 мин к прошлой неделе');
    expect(compareMinutes(100, 105, f)).toBe('как на прошлой неделе');
    expect(compareMinutes(60, 120, f)).toBe('−60 мин к прошлой неделе');
  });
});
