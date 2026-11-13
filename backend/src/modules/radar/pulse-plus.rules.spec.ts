import { forecastRange, formatRange, hoursLine, isStale, loadLabel, messageGrounded, showTrial, statusMessage, topSteps, trialSteps } from './pulse-plus.rules';
import { dueNow, weeklyText } from './pulse-weekly.rules';

const now = new Date('2026-11-13T10:00:00Z');

describe('Пульс #4890 — правила экрана', () => {
  it('п. 9: метки вместо процентов, проверки — первыми', () => {
    expect(loadLabel({ reviews: 91, active: 5, overdue: 4, points: 20, norm: 12 })).toBe('reviews');
    expect(loadLabel({ reviews: 0, active: 12, overdue: 9, points: 20, norm: 12 })).toBe('overdue');
    expect(loadLabel({ reviews: 0, active: 3, overdue: 0, points: 4, norm: 12 })).toBe('spare');
    expect(loadLabel({ reviews: 0, active: 8, overdue: 1, points: 10, norm: 12 })).toBe('normal');
  });

  it('п. 9: часы — только из оценок и с покрытием', () => {
    expect(hoursLine({ estimated: 30, withEstimate: 3, total: 4, available: 25 })).toBe('30 ч из 25 ч доступных · оценки есть у 3 из 4 задач');
    expect(hoursLine({ estimated: 0, withEstimate: 0, total: 5, available: 25 })).toContain('часы не считаем');
    expect(hoursLine({ estimated: 30, withEstimate: 3, total: 4, available: 25 })).not.toMatch(/%/);
  });

  it('п. 10: дата — диапазоном; ничего не закрывают — прогноза нет', () => {
    const r = forecastRange({ weekly: [20, 30, 18, 28], remaining: 208, now });
    expect(r?.kind).toBe('range');
    expect(r!.from <= r!.to).toBe(true);
    expect(forecastRange({ weekly: [0, 0, 0, 0], remaining: 5, now })).toBeNull();
    expect(forecastRange({ weekly: [0, 0, 0, 3], remaining: 5, now })?.text.startsWith('≈')).toBe(true);
    expect(formatRange(new Date('2027-01-03T00:00:00Z'), new Date('2027-01-20T00:00:00Z'))).toBe('3–20 января');
  });

  it('п. 10: стоит 4+ недели — без закрытий и без движения', () => {
    expect(isStale({ open: 3, weekly: [0, 0, 0, 0], lastMove: new Date('2026-09-01T00:00:00Z'), now })).toBe(true);
    expect(isStale({ open: 3, weekly: [0, 0, 0, 0], lastMove: new Date('2026-11-10T00:00:00Z'), now })).toBe(false);
    expect(isStale({ open: 3, weekly: [0, 1, 0, 0], lastMove: null, now })).toBe(false);
  });

  it('п. 7: шаги по эффекту, не больше трёх', () => {
    const s = topSteps([
      { kind: 'assign', key: 'a', title: 'a', detail: '', effect: 1, button: 'x' },
      { kind: 'nudge', key: 'b', title: 'b', detail: '', effect: 4, button: 'x' },
      { kind: 'stale', key: 'c', title: 'c', detail: '', effect: 3, button: 'x' },
      { kind: 'balance', key: 'd', title: 'd', detail: '', effect: 2, button: 'x' },
    ]);
    expect(s.map((x) => x.key)).toEqual(['b', 'c', 'd']);
  });

  it('п. 8: текст со всеми задачами и вопросом; модель без чужих номеров', () => {
    const tasks = [{ id: '1233', title: 'Голосовой поиск', days: 67 }, { id: '1293', title: 'Блок ИИ-бота', days: 53 }];
    const t = statusMessage({ name: 'Сергей Попович', kind: 'overdue', tasks });
    expect(t).toContain('#1233');
    expect(t).toContain('#1293');
    expect(t).toContain('что осталось и когда реально сдашь');
    expect(t.startsWith('Сергей, привет!')).toBe(true);
    expect(messageGrounded(t, ['1233', '1293'])).toBe(true);
    expect(messageGrounded(`${t}\n#999 лишняя`, ['1233', '1293'])).toBe(false);
    expect(messageGrounded('Сергей, как дела по задачам? #1233', ['1233', '1293'])).toBe(false);
  });

  it('п. 11: четыре шага; зрелой команде обычный Пульс', () => {
    const fresh = { colleagues: 1, invites: 1, tasksWithDeadline: 12, reviewerSet: false, closed: 2 };
    const steps = trialSteps(fresh);
    expect(steps.map((x) => x.done)).toEqual([false, true, false, false]);
    expect(showTrial(fresh)).toBe(true);
    expect(showTrial({ colleagues: 5, invites: 0, tasksWithDeadline: 40, reviewerSet: true, closed: 9 })).toBe(false);
    expect(showTrial({ colleagues: 1, invites: 0, tasksWithDeadline: 400, reviewerSet: true, closed: 300 })).toBe(false);
  });

  it('п. 12: понедельник 9:00, можно выключить и перенести', () => {
    const p = { enabled: true, weekday: 1, atTime: '09:00' };
    expect(dueNow(p, { weekday: 1, minutes: 9 * 60 + 5 })).toBe(true);
    expect(dueNow(p, { weekday: 1, minutes: 8 * 60 + 59 })).toBe(false);
    expect(dueNow(p, { weekday: 2, minutes: 9 * 60 + 5 })).toBe(false);
    expect(dueNow({ ...p, enabled: false }, { weekday: 1, minutes: 9 * 60 + 5 })).toBe(false);
    expect(dueNow({ ...p, weekday: 3, atTime: '14:30' }, { weekday: 3, minutes: 14 * 60 + 40 })).toBe(true);
    const t = weeklyText({ team: 'Продуктовая команда', score: 56, trend: 9, speed: 'закрыто 48 задач против 34', main: '71 задача ждёт вашей проверки, самая старая — 27 дней.', steps: [{ title: 'Разобрать 10 старых проверок (~20 мин)', effect: 6 }] });
    expect(t).toContain('Пульс недели · Продуктовая команда');
    expect(t).toContain('Индекс: 56 (▲ +9 за неделю)');
    expect(t).toContain('1. Разобрать 10 старых проверок (~20 мин) — индекс +6');
  });
});
