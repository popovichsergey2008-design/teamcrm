import { occurrences } from './recurrence';
import { zonedToUtc } from './find-time';

const TZ = 'Europe/Moscow';
const at = (m: number, d: number, h = 10) => zonedToUtc(2026, m, d, h, 0, TZ);

describe('#4787 — повторы встречи', () => {
  it('каждую неделю до даты', () => {
    expect(occurrences(at(11, 2), 'weekly', TZ, { until: '2026-11-23' })).toEqual([at(11, 2), at(11, 9), at(11, 16), at(11, 23)]);
  });
  it('по будням — без субботы и воскресенья', () => {
    expect(occurrences(at(11, 6), 'weekdays', TZ, { count: 3 })).toEqual([at(11, 6), at(11, 9), at(11, 10)]);
  });
  it('каждый месяц: 31-го в коротких месяцах не бывает', () => {
    const r = occurrences(zonedToUtc(2026, 1, 31, 10, 0, TZ), 'monthly', TZ, { count: 3 });
    expect(r).toEqual([zonedToUtc(2026, 1, 31, 10, 0, TZ), zonedToUtc(2026, 3, 31, 10, 0, TZ), zonedToUtc(2026, 5, 31, 10, 0, TZ)]);
  });
  it('не больше 100 повторов', () => {
    expect(occurrences(at(11, 2), 'daily', TZ).length).toBe(100);
  });
});
