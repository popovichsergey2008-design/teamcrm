import { describeRule, nextRun, normalizeRule, RecurrenceRule, weekdayOf } from './recurrence';

/**
 * Календарь ошибается молча: задача просто появляется не в тот день. Поэтому здесь
 * проверяются ровно те места, где ошибаются все: 31-е число в коротком месяце, конец
 * года, перевод часов и пояс человека против пояса сервера.
 */

const rule = (over: Partial<RecurrenceRule>): RecurrenceRule => ({
  freq: 'daily', weekdays: [], monthday: null, intervalDays: null,
  atTime: '10:00', tz: 'Europe/Moscow', ...over,
});

/** Местная дата и время срабатывания — то, что человек увидит сроком задачи. */
const local = (d: Date, tz = 'Europe/Moscow') => new Intl.DateTimeFormat('en-CA', {
  timeZone: tz, hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
}).format(d).replace(',', '');

describe('повтор: разбор расписания', () => {
  it('бессмыслицу не чиним молча, а отвергаем', () => {
    expect(normalizeRule(null)).toBeNull();
    expect(normalizeRule({ freq: 'weekly', weekdays: [], atTime: '10:00' })).toBeNull();
    expect(normalizeRule({ freq: 'monthly', monthday: 0, atTime: '10:00' })).toBeNull();
    expect(normalizeRule({ freq: 'monthly', monthday: 32, atTime: '10:00' })).toBeNull();
    expect(normalizeRule({ freq: 'days', intervalDays: 0, atTime: '10:00' })).toBeNull();
    expect(normalizeRule({ freq: 'daily', atTime: '25:00' })).toBeNull();
    expect(normalizeRule({ freq: 'daily', atTime: 'утром' })).toBeNull();
    expect(normalizeRule({ freq: 'ежедневно' as never, atTime: '10:00' })).toBeNull();
  });

  it('дни недели чистятся от дублей и мусора и идут с понедельника', () => {
    const r = normalizeRule({ freq: 'weekly', weekdays: [5, 1, 5, 9, 0], atTime: '9:05' });
    expect(r?.weekdays).toEqual([1, 5]);
    expect(r?.atTime).toBe('09:05');
    // минуты — всегда две цифры: «9:5» это не время, а опечатка
    expect(normalizeRule({ freq: 'daily', atTime: '9:5' })).toBeNull();
  });

  it('незнакомый пояс не роняет повтор, а подменяется московским', () => {
    expect(normalizeRule({ freq: 'daily', atTime: '10:00', tz: 'Средиземье/Шир' })?.tz).toBe('Europe/Moscow');
    expect(normalizeRule({ freq: 'daily', atTime: '10:00', tz: 'Asia/Kolkata' })?.tz).toBe('Asia/Kolkata');
  });
});

describe('повтор: когда сработает', () => {
  it('ежедневно: сегодня, если время ещё не прошло, иначе завтра', () => {
    const morning = new Date('2026-09-07T05:00:00Z'); // 08:00 в Москве
    expect(local(nextRun(rule({}), morning))).toBe('2026-09-07 10:00');
    const evening = new Date('2026-09-07T18:00:00Z'); // 21:00 в Москве
    expect(local(nextRun(rule({}), evening))).toBe('2026-09-08 10:00');
  });

  it('еженедельно: ближайший из выбранных дней', () => {
    // 7 сентября 2026 — понедельник
    expect(weekdayOf(2026, 9, 7)).toBe(1);
    const r = rule({ freq: 'weekly', weekdays: [1, 4] }); // понедельник и четверг
    const monEvening = new Date('2026-09-07T18:00:00Z');
    expect(local(nextRun(r, monEvening))).toBe('2026-09-10 10:00');
    const thuEvening = new Date('2026-09-10T18:00:00Z');
    expect(local(nextRun(r, thuEvening))).toBe('2026-09-14 10:00');
  });

  it('ежемесячно 31-го: в коротком месяце — последний день, а не пропуск', () => {
    const r = rule({ freq: 'monthly', monthday: 31 });
    const feb = new Date('2026-02-01T00:00:00Z');
    expect(local(nextRun(r, feb))).toBe('2026-02-28 10:00');
    const jan = new Date('2026-01-01T00:00:00Z');
    expect(local(nextRun(r, jan))).toBe('2026-01-31 10:00');
    // високосный год: 29-е существует, и терять его нельзя
    expect(local(nextRun(r, new Date('2028-02-01T00:00:00Z')))).toBe('2028-02-29 10:00');
  });

  it('ежемесячно: конец года не сбивает счёт', () => {
    const r = rule({ freq: 'monthly', monthday: 5 });
    expect(local(nextRun(r, new Date('2026-12-06T12:00:00Z')))).toBe('2027-01-05 10:00');
  });

  it('каждые N дней считаются от прошлого срабатывания', () => {
    const r = rule({ freq: 'days', intervalDays: 10 });
    expect(local(nextRun(r, new Date('2026-09-07T07:00:00Z')))).toBe('2026-09-17 10:00');
    expect(local(nextRun(r, new Date('2026-12-28T07:00:00Z')))).toBe('2027-01-07 10:00');
  });

  it('время считается в поясе человека, а не сервера', () => {
    const r = rule({ freq: 'daily', atTime: '10:00', tz: 'Asia/Vladivostok' });
    const when = nextRun(r, new Date('2026-09-07T05:00:00Z'));
    expect(local(when, 'Asia/Vladivostok')).toBe('2026-09-08 10:00');
    // тот же момент по Москве — уже другой час: в UTC хранится одно, показывается разное
    expect(local(when, 'Europe/Moscow')).toBe('2026-09-08 03:00');
  });

  it('перевод часов не сдвигает время срабатывания', () => {
    const r = rule({ freq: 'daily', atTime: '10:00', tz: 'Europe/Berlin' });
    // ночь на 25 октября 2026 — переход с летнего времени
    const before = nextRun(r, new Date('2026-10-24T12:00:00Z'));
    const after = nextRun(r, new Date('2026-10-25T12:00:00Z'));
    expect(local(before, 'Europe/Berlin')).toBe('2026-10-25 10:00');
    expect(local(after, 'Europe/Berlin')).toBe('2026-10-26 10:00');
  });

  it('следующее срабатывание всегда СТРОГО после точки отсчёта', () => {
    const r = rule({ freq: 'daily' });
    const exact = nextRun(r, new Date('2026-09-07T05:00:00Z'));
    expect(nextRun(r, exact).getTime()).toBeGreaterThan(exact.getTime());
  });
});

describe('повтор: подпись', () => {
  it('читается человеком', () => {
    expect(describeRule(rule({}))).toBe('каждый день в 10:00');
    expect(describeRule(rule({ freq: 'weekly', weekdays: [1, 5] })))
      .toBe('каждую неделю: понедельник, пятницу в 10:00');
    expect(describeRule(rule({ freq: 'monthly', monthday: 5 }))).toBe('каждое 5-е число в 10:00');
    expect(describeRule(rule({ freq: 'days', intervalDays: 1 }))).toBe('каждые 1 день в 10:00');
    expect(describeRule(rule({ freq: 'days', intervalDays: 3 }))).toBe('каждые 3 дня в 10:00');
    expect(describeRule(rule({ freq: 'days', intervalDays: 10 }))).toBe('каждые 10 дней в 10:00');
  });
});
