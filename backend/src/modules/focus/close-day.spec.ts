import { closeDayAvailable, DEFAULT_DAY, nextWorkStart, tomorrowOf, zonedTime } from './close-day';

const TZ = 'Europe/Moscow';

describe('завершение дня', () => {
  it('местное время в поясе — верный момент', () => {
    expect(zonedTime('2026-10-07', '09:00', TZ).toISOString()).toBe('2026-10-07T06:00:00.000Z');
    expect(zonedTime('2026-10-07', '09:00', 'Asia/Novosibirsk').toISOString()).toBe('2026-10-07T02:00:00.000Z');
  });

  it('кнопка — за полчаса до конца дня или когда тройка сделана', () => {
    const at = (hhmm: string) => zonedTime('2026-10-07', hhmm, TZ);
    expect(closeDayAvailable(at('15:00'), TZ, DEFAULT_DAY, 1, 3)).toBe(false);
    expect(closeDayAvailable(at('18:05'), TZ, DEFAULT_DAY, 1, 3)).toBe(true);
    expect(closeDayAvailable(at('11:00'), TZ, DEFAULT_DAY, 3, 3)).toBe(true);
    // пустой план «сделанным» не считается
    expect(closeDayAvailable(at('11:00'), TZ, DEFAULT_DAY, 0, 0)).toBe(false);
  });

  it('следующее утро пропускает выходные', () => {
    // пятница, 9 октября 2026, вечер → понедельник 12-го в 9:00
    const fri = zonedTime('2026-10-09', '19:00', TZ);
    expect(nextWorkStart(fri, TZ, DEFAULT_DAY).toISOString()).toBe(zonedTime('2026-10-12', '09:00', TZ).toISOString());
    // среда вечер → четверг утро
    const wed = zonedTime('2026-10-07', '19:00', TZ);
    expect(nextWorkStart(wed, TZ, DEFAULT_DAY).toISOString()).toBe(zonedTime('2026-10-08', '09:00', TZ).toISOString());
  });

  it('закрыли после полуночи — до сегодняшнего утра, праздник пропускаем', () => {
    const night = zonedTime('2026-10-08', '01:00', TZ);
    expect(nextWorkStart(night, TZ, DEFAULT_DAY).toISOString()).toBe(zonedTime('2026-10-08', '09:00', TZ).toISOString());
    const holiday = { ...DEFAULT_DAY, holidays: ['2026-10-08'] };
    expect(nextWorkStart(zonedTime('2026-10-07', '19:00', TZ), TZ, holiday).toISOString())
      .toBe(zonedTime('2026-10-09', '09:00', TZ).toISOString());
  });

  it('завтра — по местному календарю', () => {
    expect(tomorrowOf(zonedTime('2026-10-07', '23:30', TZ), TZ)).toBe('2026-10-08');
  });
});
