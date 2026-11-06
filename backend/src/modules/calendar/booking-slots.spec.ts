import { bookingSlots, slotAllowed, BookingRules } from './booking-slots';
import { zonedToUtc } from './find-time';

const TZ = 'Europe/Moscow';
const at = (d: number, h: number, m = 0) => zonedToUtc(2026, 11, d, h, m, TZ); // 2.11.2026 — понедельник
const iso = (ms: number) => new Date(ms).toISOString();
const WEEK: BookingRules['weekly'] = { 1: [['09:00', '13:00'], ['14:00', '18:00']], 2: [['09:00', '18:00']], 3: [['09:00', '18:00']], 4: [['09:00', '18:00']], 5: [['09:00', '18:00']] };
const rules = (over: Partial<BookingRules> = {}): BookingRules => ({
  weekly: WEEK, blockedDates: [], vacations: [], maxPerDay: null, minNoticeMin: 0, horizonDays: 7, ...over,
});
const type = { durationMin: 30, weekly: null, bufferBefore: 0, bufferAfter: 0 };

describe('#4787 — свободное время для записи', () => {
  it('перерыв внутри дня: в обед слотов нет', () => {
    const d = bookingSlots({ now: at(2, 8), rules: rules({ horizonDays: 1 }), type, busy: [], meetingsPerDay: {}, timeZone: TZ });
    expect(d[0].slots).toContain(iso(at(2, 12, 30)));
    expect(d[0].slots).not.toContain(iso(at(2, 12, 45)));
    expect(d[0].slots).not.toContain(iso(at(2, 13, 30)));
    expect(d[0].slots).toContain(iso(at(2, 14)));
  });

  it('пример из ТЗ: только вт и чт, 11–16, перерыв 10 минут после, запись за 3 часа', () => {
    const d = bookingSlots({
      now: at(3, 9), rules: rules({ minNoticeMin: 180 }),
      type: { durationMin: 30, weekly: { 2: [['11:00', '16:00']], 4: [['11:00', '16:00']] }, bufferBefore: 0, bufferAfter: 10 },
      busy: [{ start: at(3, 13), end: at(3, 14) }], meetingsPerDay: {}, timeZone: TZ,
    });
    expect(d.map((x) => x.date)).toEqual(['2026-11-03', '2026-11-05']);
    const tue = d[0].slots;
    expect(tue[0]).toBe(iso(at(3, 12))); // 9:00 + 3 часа
    expect(tue).not.toContain(iso(at(3, 12, 30))); // 12:30–13:00 + 10 минут перерыва упирается во встречу в 13:00
    expect(tue).toContain(iso(at(3, 14)));
    expect(tue[tue.length - 1]).toBe(iso(at(3, 15, 30)));
  });

  it('закрытые даты, отпуск и среда без внешних встреч', () => {
    const d = bookingSlots({
      now: at(2, 8),
      rules: rules({ weekly: { ...WEEK, 3: [] }, blockedDates: ['2026-11-04'], vacations: [{ from: '2026-11-05', to: '2026-11-06' }] }),
      type, busy: [], meetingsPerDay: {}, timeZone: TZ,
    });
    expect(d.map((x) => x.date)).toEqual(['2026-11-02', '2026-11-03']);
  });

  it('не больше N встреч в день', () => {
    const d = bookingSlots({ now: at(2, 8), rules: rules({ maxPerDay: 4, horizonDays: 2 }), type, busy: [], meetingsPerDay: { '2026-11-02': 4 }, timeZone: TZ });
    expect(d.map((x) => x.date)).toEqual(['2026-11-03']);
  });

  it('выбранное время проверяется тем же правилом', () => {
    const input = { now: at(2, 8), rules: rules({ horizonDays: 1 }), type, busy: [{ start: at(2, 10), end: at(2, 11) }], meetingsPerDay: {}, timeZone: TZ };
    expect(slotAllowed(input, at(2, 9, 30))).toBe(true);
    expect(slotAllowed(input, at(2, 10))).toBe(false);
    expect(slotAllowed(input, at(2, 9, 40))).toBe(false); // не по шагу
  });
});
