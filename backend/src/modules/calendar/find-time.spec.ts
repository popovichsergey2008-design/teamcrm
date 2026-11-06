import { findTime, freeSlots, planDay, workWindows, zonedToUtc } from './find-time';

const TZ = 'Europe/Moscow';
const WORK = { workStart: '09:00', workEnd: '18:00', weekendDays: [0, 6], holidays: [] as string[] };
const at = (d: number, h: number, m = 0) => zonedToUtc(2026, 11, d, h, m, TZ); // ноябрь 2026, 2-е — понедельник
const iso = (ms: number) => new Date(ms).toISOString();

describe('#4787 — найти время для задачи', () => {
  it('рабочие окна: выходные пропускаются, часы — в поясе человека', () => {
    const w = workWindows(at(6, 8), 3, WORK, TZ); // пятница 6.11 → пт, сб, вс
    expect(w).toEqual([{ start: at(6, 9), end: at(6, 18) }]);
  });

  it('свободное время — рабочее окно минус встречи', () => {
    const f = freeSlots([{ start: at(2, 9), end: at(2, 18) }], [{ start: at(2, 10), end: at(2, 11) }, { start: at(2, 15), end: at(2, 16) }]);
    expect(f).toEqual([
      { start: at(2, 9), end: at(2, 10) },
      { start: at(2, 11), end: at(2, 15) },
      { start: at(2, 16), end: at(2, 18) },
    ]);
  });

  it('не ставит поверх встречи и предлагает по варианту на день', () => {
    const r = findTime({
      now: at(2, 14, 7), minutes: 50, deadline: at(6, 18), work: WORK, timeZone: TZ,
      busy: [{ start: at(2, 14, 30), end: at(2, 15) }, { start: at(2, 16), end: at(2, 17) }],
    });
    expect(r.message).toBeNull();
    expect(r.options[0]).toEqual({
      startsAt: iso(at(2, 15)), endsAt: iso(at(2, 15, 50)), note: 'Есть свободное окно до следующего звонка.',
    });
    expect(r.options[1].startsAt).toBe(iso(at(3, 9)));
    expect(r.options[1].note).toBe('Подходит по рабочим часам, задача будет выполнена до срока.');
    for (const o of r.options) {
      expect(Date.parse(o.endsAt)).toBeLessThanOrEqual(at(6, 18));
    }
  });

  it('за срок не уходит: окна нет — честно говорит и советует разделить', () => {
    const r = findTime({
      now: at(2, 9), minutes: 90, deadline: at(2, 12), work: WORK, timeZone: TZ,
      busy: [{ start: at(2, 10), end: at(2, 11) }],
    });
    expect(r.options).toEqual([]);
    expect(r.message).toBe('До срока нет свободного окна на 90 минут. Можно разделить работу на два подхода или пересмотреть план.');
  });

  it('срок прошёл — не предлагает время после него', () => {
    const r = findTime({ now: at(3, 10), minutes: 30, deadline: at(2, 18), work: WORK, timeZone: TZ, busy: [] });
    expect(r.options).toEqual([]);
    expect(r.message).toMatch(/Срок задачи уже прошёл/);
  });

  it('без срока ищет на горизонте и в праздник не ставит', () => {
    const r = findTime({
      now: at(2, 18, 30), minutes: 60, deadline: null, timeZone: TZ, busy: [],
      work: { ...WORK, holidays: ['2026-11-03'] },
    });
    expect(r.options[0].startsAt).toBe(iso(at(4, 9)));
    expect(r.options[0].note).toBe('Подходит по рабочим часам.');
  });
});

describe('#4787 — помоги спланировать день', () => {
  it('ставит задачи в окна между встречами с перерывами', () => {
    const r = planDay({
      now: at(2, 9, 20), date: '2026-11-02', timeZone: TZ, work: WORK, breakMin: 10,
      busy: [{ start: at(2, 10, 30), end: at(2, 11) }, { start: at(2, 12), end: at(2, 14) }],
      items: [{ id: 'a', minutes: 50 }, { id: 'b', minutes: 45 }, { id: 'c', minutes: 50 }],
    });
    expect(r.plan).toEqual([
      { id: 'a', startsAt: iso(at(2, 9, 25)), endsAt: iso(at(2, 10, 15)) },
      { id: 'b', startsAt: iso(at(2, 11)), endsAt: iso(at(2, 11, 45)) },
      { id: 'c', startsAt: iso(at(2, 14)), endsAt: iso(at(2, 14, 50)) },
    ]);
    expect(r.unplaced).toEqual([]);
  });

  it('не обещает больше, чем вмещает день', () => {
    const r = planDay({
      now: at(2, 15), date: '2026-11-02', timeZone: TZ, work: WORK,
      busy: [], items: [{ id: 'a', minutes: 120 }, { id: 'b', minutes: 120 }, { id: 'c', minutes: 60 }],
    });
    expect(r.plan.map((p) => p.id)).toEqual(['a']);
    expect(r.unplaced).toEqual(['b', 'c']);
    expect(r.message).toBe('На задачи нужно 5 ч, свободно 2 ч 55 мин. Выберите, что оставить на сегодня.');
  });
});
