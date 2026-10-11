import { assess, dayWord, LocalDate } from './workload-rules';

const now = new Date('2026-10-12T08:00:00Z'); // понедельник
const local: LocalDate = (d) => {
  const date = d.toISOString().slice(0, 10);
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return { date, isoDow: dow === 0 ? 7 : dow };
};
const thu = new Date('2026-10-15T15:00:00Z');

describe('страж нагрузки', () => {
  it('4 срочные на четверг — предупреждение, другой срок и подходящий человек', () => {
    const sergey = {
      id: '1', name: 'Сергей Попович', points: 9, norm: 12,
      tasks: Array.from({ length: 4 }, () => ({ priority: 'urgent' as const, deadlineAt: new Date('2026-10-15T12:00:00Z') })),
    };
    const a = assess(sergey, { priority: 'urgent', deadlineAt: thu, directions: [], allowed: null }, [
      { id: '2', name: 'Константин', points: 4, norm: 12, skills: [], canReceive: true, available: true },
      { id: '3', name: 'В отпуске', points: 0, norm: 12, skills: [], canReceive: true, available: false },
      { id: '4', name: 'Не берёт', points: 0, norm: 12, skills: [], canReceive: false, available: true },
    ], now, local);
    expect(a.warn).toBe(true);
    expect(a.reasons[0]).toBe('Сергей: на четверг уже 4 срочные задачи.');
    expect(a.alternativeDate).toBe('2026-10-16');
    expect(a.alternatives.map((x) => x.name)).toEqual(['Константин']);
  });

  it('свободный человек — без предупреждения', () => {
    const a = assess({ id: '1', name: 'Анна', points: 3, norm: 12, tasks: [] }, { priority: 'normal', deadlineAt: thu, directions: [], allowed: null }, [], now, local);
    expect(a.warn).toBe(false);
  });

  it('перегруз по очкам; замена — только по направлению и с доступом к проекту', () => {
    const a = assess({ id: '1', name: 'Глеб', points: 12, norm: 12, tasks: [] }, { priority: 'high', deadlineAt: null, directions: ['frontend'], allowed: new Set(['1', '3']) }, [
      { id: '2', name: 'Без доступа', points: 0, norm: 12, skills: ['frontend'], canReceive: true, available: true },
      { id: '3', name: 'Фронтенд', points: 2, norm: 12, skills: ['frontend'], canReceive: true, available: true },
      { id: '5', name: 'Бэкенд', points: 0, norm: 12, skills: ['backend'], canReceive: true, available: true },
    ], now, local);
    expect(a.after).toBeGreaterThan(100);
    expect(a.level).toBe('overloaded');
    expect(a.alternatives.map((x) => x.name)).toEqual(['Фронтенд']);
  });

  it('подпись дня', () => {
    expect(dayWord('2026-10-12', '2026-10-12')).toBe('на сегодня');
    expect(dayWord('2026-10-13', '2026-10-12')).toBe('на завтра');
    expect(dayWord('2026-10-15', '2026-10-12')).toBe('на четверг');
    expect(dayWord('2026-10-30', '2026-10-12')).toBe('на 30.10');
  });
});
