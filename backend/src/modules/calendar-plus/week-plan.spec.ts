import { zonedToUtc } from '../calendar/find-time';
import { focusFill, planWeek, relocate, WeekCtx } from './week-plan';

const MSK = 'Europe/Moscow';
const at = (d: number, h: number, m = 0) => zonedToUtc(2026, 11, d, h, m, MSK);
const ctx = (busy: { start: number; end: number }[] = []): WeekCtx => ({
  now: at(16, 8), from: at(16, 0), to: at(21, 0), timeZone: MSK,
  work: { workStart: '10:00', workEnd: '19:00', weekendDays: [0, 6], holidays: [] },
  lunch: { start: '13:00', end: '14:00' }, busy,
});

describe('#4892 п. 8: «Разложить по неделе»', () => {
  it('задачи — до срока, не поверх встреч, не в обед; сроки не меняются', () => {
    const meeting = { start: at(16, 10), end: at(16, 12) };
    const r = planWeek(ctx([meeting]), [
      { id: 'a', title: 'Макет', deadline: at(20, 18), estimateMin: 120 },
      { id: 'b', title: 'Отзывы', deadline: at(17, 13), estimateMin: 60 },
    ]);
    expect(r.unplaced).toEqual([]);
    for (const p of r.placements) {
      expect(p.start < meeting.end && p.end > meeting.start).toBe(false);
      expect(p.start < at(16, 14) && p.end > at(16, 13)).toBe(false);
    }
    const b = r.placements.find((p) => p.taskId === 'b')!;
    expect(b.end <= at(17, 13)).toBe(true);
  });
  it('не влезает — честно в unplaced', () => {
    const r = planWeek(ctx([{ start: at(16, 8), end: at(16, 23) }]), [{ id: 'x', title: 'X', deadline: at(16, 19), estimateMin: 120 }]);
    expect(r.unplaced).toEqual(['x']);
  });
});

describe('#4892 п. 9: цель фокуса', () => {
  it('добирает цель утренними окнами от 2 ч, по одному в день', () => {
    const blocks = focusFill(ctx(), 6 * 60);
    expect(blocks.reduce((n, b) => n + (b.end - b.start), 0)).toBe(6 * 3600_000);
    expect(new Set(blocks.map((b) => new Date(b.start).getUTCDate())).size).toBe(blocks.length);
    expect(blocks[0].start).toBe(at(16, 10));
  });
  it('встречу поставили на фокус — блок переезжает в свободное окно того же дня', () => {
    const block = { start: at(17, 10), end: at(17, 12) };
    const to = relocate(block, ctx([{ start: at(17, 10), end: at(17, 11) }]))!;
    expect(to).not.toBeNull();
    expect(to.start >= at(17, 11)).toBe(true);
    expect(new Date(to.start).getUTCDate()).toBe(17);
  });
});
