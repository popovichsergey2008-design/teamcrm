import { zonedToUtc } from '../calendar/find-time';
import { dayPlan, reviewsMinutes, shortTitle } from './day-plan';

const MSK = 'Europe/Moscow';
const at = (h: number, m = 0) => zonedToUtc(2026, 11, 12, h, m, MSK);
const base = {
  now: at(8, 0), date: '2026-11-12', timeZone: MSK, workStart: '10:00', workEnd: '19:00', lunchStart: '13:00', lunchEnd: '14:00',
  otherBlocks: [],
};

describe('#4891 п. 1: ёмкость дня и таймлайн', () => {
  it('рабочий день − встречи = доступно; запланировано и резерв сходятся', () => {
    const p = dayPlan({
      ...base,
      meetings: [{ title: 'Созвон', start: at(12), end: at(12, 30) }, { title: 'Клиент', start: at(16), end: at(17) }],
      items: [
        { id: '1', taskId: '10', title: 'Тест бота', kind: 'task', estimateMin: 120, rank: 1, done: false },
        { id: '2', taskId: '11', title: 'Макет', kind: 'task', estimateMin: null, rank: 2, done: false },
      ],
      reviews: 10,
    });
    expect(p.workMin).toBe(8 * 60);
    expect(p.meetingMin).toBe(90);
    expect(p.availableMin).toBe(8 * 60 - 90);
    expect(p.plannedMin).toBe(180);
    expect(p.reviewsMin).toBe(reviewsMinutes(10));
    expect(p.reserveMin + p.plannedMin + p.reviewsMin).toBe(p.availableMin);
    expect(p.overloadMin).toBe(0);
    const tasks = p.timeline.filter((s) => s.kind === 'task');
    expect(tasks[0].start).toBe(at(10));
    expect(tasks.find((t) => t.taskId === '11')?.estimated).toBe(true);
    // задачи не поверх встреч и обеда
    for (const t of tasks) for (const m of p.timeline.filter((s) => s.kind === 'meeting' || s.kind === 'lunch')) expect(t.start < m.end && t.end > m.start).toBe(false);
  });
  it('перегруз: задач больше, чем свободного времени (п. 1а)', () => {
    const p = dayPlan({
      ...base, meetings: [{ title: 'Весь день', start: at(10), end: at(17) }],
      items: [{ id: '1', taskId: '10', title: 'A', kind: 'task', estimateMin: 180, rank: 1, done: false }], reviews: 0,
    });
    expect(p.overloadMin).toBe(180 - (8 * 60 - 6 * 60));
    expect(p.unplaced).toEqual(['1']);
  });
  it('короткое название без «Проверить и принять:» и обрыва слова', () => {
    expect(shortTitle('Проверить и принять: Сверстать страницу тарифов')).toBe('Сверстать страницу тарифов');
    const long = shortTitle('Протестировать десять сценариев нового разговора бота с пользователями из демо-пространства');
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith(' ')).toBe(false);
  });
});
