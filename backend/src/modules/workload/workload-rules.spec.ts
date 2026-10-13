import { assess, basisText, dayWord, LocalDate } from './workload-rules';

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
    // от сегодня (пн 12.10): вторник свободен
    expect(a.alternativeDate).toBe('2026-10-13');
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

describe('страж нагрузки: дата и разбивка (#1553)', () => {
  const busy = (dates: string[]) => dates.map((d) => ({ priority: 'normal' as const, deadlineAt: new Date(`${d}T12:00:00Z`) }));

  it('другой срок — от сегодня и не дальше двух недель, повтор не уводит дату', () => {
    const gleb = { id: '1', name: 'Глеб', points: 20, norm: 12, tasks: busy(['2026-10-13', '2026-10-13', '2026-10-14', '2026-10-14']) };
    const a = assess(gleb, { priority: 'normal', deadlineAt: new Date('2026-10-20T15:00:00Z'), directions: [], allowed: null }, [], now, local);
    expect(a.warn).toBe(true);
    expect(a.alternativeDate).toBe('2026-10-15');
    // со сроком позже (как после «сдвинуть») — та же дата, а не ещё на день дальше
    const again = assess(gleb, { priority: 'normal', deadlineAt: new Date('2026-10-22T15:00:00Z'), directions: [], allowed: null }, [], now, local);
    expect(again.alternativeDate).toBe('2026-10-15');
  });

  it('все две недели заняты — дату не предлагаем', () => {
    const days = Array.from({ length: 20 }, (_, i) => new Date(now.getTime() + (i + 1) * 86_400_000).toISOString().slice(0, 10));
    const a = assess({ id: '1', name: 'Глеб', points: 20, norm: 12, tasks: busy([...days, ...days]) },
      { priority: 'normal', deadlineAt: null, directions: [], allowed: null }, [], now, local);
    expect(a.warn).toBe(true);
    expect(a.alternativeDate).toBeNull();
  });

  it('задача со сроком через месяц сегодняшнюю загрузку не меняет — без предупреждения', () => {
    const a = assess({ id: '1', name: 'Глеб', points: 20, norm: 12, tasks: [] },
      { priority: 'normal', deadlineAt: new Date('2026-11-20T15:00:00Z'), directions: [], allowed: null }, [], now, local);
    expect(a.warn).toBe(false);
  });

  it('разбивка словами', () => {
    expect(basisText({ overdue: 18, inWindow: 1, moving: 4, later: 8, reviews: 0, meetingHours: 0 }))
      .toBe('Считаем задачи на ближайшие 2 недели, часы не нужны: 18 просрочено, 1 со сроком в эти 2 недели, 4 в работе без срока. Не считаем 8 задач без движения и без близкого срока.');
    expect(basisText(undefined)).toBeNull();
  });
});
