import { nextRun, parseSchedule, scheduleLabel } from './schedule-ru';

/**
 * Разбор расписания — правилами, поэтому и проверяется правилами, без модели.
 * Ошибка здесь незаметна: отчёт просто не придёт, и узнают об этом через неделю.
 */
describe('расписание из фразы', () => {
  it('понимает день недели, будни, месяц и просто «каждый день»', () => {
    expect(parseSchedule('каждый понедельник в 9:00 дай список просроченных'))
      .toEqual({ kind: 'weekly', time: '09:00', weekday: 1 });
    expect(parseSchedule('каждую пятницу вечером собери отчёт'))
      .toEqual({ kind: 'weekly', time: '18:00', weekday: 5 });
    expect(parseSchedule('каждый рабочий день в 17:00 короткую сводку'))
      .toEqual({ kind: 'weekdays', time: '17:00' });
    expect(parseSchedule('по будням утром'))
      .toEqual({ kind: 'weekdays', time: '09:00' });
    expect(parseSchedule('5 числа каждого месяца в 10:00 отчёт по проекту'))
      .toEqual({ kind: 'monthly', time: '10:00', day: 5 });
    expect(parseSchedule('каждый вечер собери задачи на согласование'))
      .toEqual({ kind: 'daily', time: '18:00' });
  });

  it('без слов о повторении расписания НЕТ — это обычная просьба', () => {
    expect(parseSchedule('дай список просроченных задач')).toBeNull();
    expect(parseSchedule('напомни завтра в 9:00 позвонить')).toBeNull();
  });

  it('время суток и «вечера» разбираются как у людей', () => {
    expect(parseSchedule('каждый день в 7 вечера')?.time).toBe('19:00');
    expect(parseSchedule('каждый день в 7 утра')?.time).toBe('07:00');
    expect(parseSchedule('каждый день в 17.30')?.time).toBe('17:30');
    // без времени — утро: отчёт нужен к началу дня, а не когда придётся
    expect(parseSchedule('каждый понедельник отчёт')?.time).toBe('09:00');
  });

  it('подпись читается вслух', () => {
    expect(scheduleLabel({ kind: 'weekly', time: '09:00', weekday: 1 })).toBe('каждый понедельник в 9:00');
    expect(scheduleLabel({ kind: 'weekly', time: '18:00', weekday: 3 })).toBe('каждую среду в 18:00');
    expect(scheduleLabel({ kind: 'weekdays', time: '17:00' })).toBe('по будням в 17:00');
    expect(scheduleLabel({ kind: 'monthly', time: '10:00', day: 5 })).toBe('5 числа каждого месяца в 10:00');
  });

  it('следующий запуск — в поясе человека и строго в будущем', () => {
    // среда, 10 сентября 2026, 12:00 UTC = 15:00 в Москве
    const now = new Date('2026-09-09T12:00:00Z');
    const mon = nextRun({ kind: 'weekly', time: '09:00', weekday: 1 }, now, 'Europe/Moscow');
    expect(mon.toISOString()).toBe('2026-09-14T06:00:00.000Z'); // понедельник, 9 утра в Москве
    // тот же понедельник по Новосибирску наступает на четыре часа раньше по UTC
    const nsk = nextRun({ kind: 'weekly', time: '09:00', weekday: 1 }, now, 'Asia/Novosibirsk');
    expect(nsk.toISOString()).toBe('2026-09-14T02:00:00.000Z');
    // сегодняшнее время уже прошло — переносим на завтра, а не запускаем немедленно
    const daily = nextRun({ kind: 'daily', time: '09:00' }, now, 'Europe/Moscow');
    expect(daily.toISOString()).toBe('2026-09-10T06:00:00.000Z');
    // будни: в пятницу вечером следующий — понедельник
    const fri = new Date('2026-09-11T18:00:00Z');
    expect(nextRun({ kind: 'weekdays', time: '10:00' }, fri, 'Europe/Moscow').toISOString())
      .toBe('2026-09-14T07:00:00.000Z');
  });
});
