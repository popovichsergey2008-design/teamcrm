import { conflicts, findSlots } from './slot-rules';

const TZ = 'Europe/Moscow';
const WORK = { workStart: '09:00', workEnd: '18:00', weekendDays: [0, 6], holidays: [] as string[] };
// среда, 7 октября 2026, 08:00 по Москве
const NOW = new Date('2026-10-07T05:00:00Z');
const msk = (d: string, hhmm: string) => new Date(`${d}T${hhmm}:00+03:00`);

describe('slot-rules: поиск окна', () => {
  it('в рабочие часы, с округлением до получаса, не больше двух в день', () => {
    const s = findSlots({ from: NOW, to: msk('2026-10-08', '23:00'), durationMin: 60, busy: [], work: WORK, tz: TZ, now: NOW });
    expect(s).toHaveLength(4);
    expect(s[0].start.toISOString()).toBe(msk('2026-10-07', '09:00').toISOString());
    expect(s[1].start.getTime() - s[0].start.getTime()).toBeGreaterThanOrEqual(2 * 3600_000);
    expect(s[2].start.toISOString()).toBe(msk('2026-10-08', '09:00').toISOString());
  });

  it('обходит занятость с буфером и не трогает прошлое', () => {
    const now = msk('2026-10-07', '09:10');
    const busy = [{ start: msk('2026-10-07', '09:30'), end: msk('2026-10-07', '11:00') }];
    const s = findSlots({ from: now, to: msk('2026-10-07', '23:00'), durationMin: 30, busy, work: WORK, tz: TZ, now, max: 1 });
    // 09:30 занято, 11:00 — впритык (буфер 10 минут), значит 11:30
    expect(s[0].start.toISOString()).toBe(msk('2026-10-07', '11:30').toISOString());
  });

  it('выходные и праздники пропускает; «весь день» не считает занятостью, отпуск — считает', () => {
    const fri = msk('2026-10-09', '17:30');
    const s = findSlots({
      from: fri, to: msk('2026-10-13', '23:00'), durationMin: 60, work: { ...WORK, holidays: ['2026-10-12'] }, tz: TZ, now: fri,
      busy: [{ start: msk('2026-10-13', '00:00'), end: msk('2026-10-14', '00:00'), kind: 'all_day' }],
      max: 1,
    });
    expect(s[0].start.toISOString()).toBe(msk('2026-10-13', '09:00').toISOString());
    const v = findSlots({
      from: fri, to: msk('2026-10-13', '23:00'), durationMin: 60, work: WORK, tz: TZ, now: fri,
      busy: [{ start: msk('2026-10-12', '00:00'), end: msk('2026-10-14', '00:00'), kind: 'vacation' }],
    });
    expect(v).toEqual([]);
  });

  it('в поясе компании Новосибирск 09:00 — это 05:00 по UTC', () => {
    const now = new Date('2026-10-07T00:00:00Z');
    const s = findSlots({ from: now, to: new Date('2026-10-07T12:00:00Z'), durationMin: 60, busy: [], work: WORK, tz: 'Asia/Novosibirsk', now, max: 1 });
    expect(s[0].start.toISOString()).toBe('2026-10-07T02:00:00.000Z');
  });
});

describe('slot-rules: конфликты', () => {
  it('находит пересечения, впритык — не конфликт', () => {
    const ev = (id: string, a: string, b: string) => ({ id, title: id, start: msk('2026-10-07', a), end: msk('2026-10-07', b) });
    const pairs = conflicts([ev('A', '10:00', '11:00'), ev('B', '10:30', '11:30'), ev('C', '11:30', '12:00')]);
    expect(pairs.map(([x, y]) => `${x.id}-${y.id}`)).toEqual(['A-B']);
  });
});
