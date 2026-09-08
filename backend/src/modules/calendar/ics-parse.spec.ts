import { expandRrule, parseIcs, parseIcsDate, unfold } from './ics-parse';

/**
 * Чужой календарь ошибается молча: при неверном разборе он просто оказывается пустым
 * или показывает встречи не в те дни. Поэтому проверяем ровно то, на чём спотыкаются
 * все: склейку длинных строк, три вида дат и разворот повторов.
 */

const CAL = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}\r\nEND:VCALENDAR\r\n`;
const from = new Date('2026-09-01T00:00:00Z');
const to = new Date('2026-10-01T00:00:00Z');

describe('ics: строки и даты', () => {
  it('длинная строка склеивается обратно', () => {
    const lines = unfold('SUMMARY:Планёрка по проек\r\n ту «Восход»\r\nEND:VEVENT');
    expect(lines[0]).toBe('SUMMARY:Планёрка по проекту «Восход»');
  });

  it('три вида даты: сутки, UTC и местное время в названной зоне', () => {
    expect(parseIcsDate('20260908')?.toISOString()).toBe('2026-09-08T00:00:00.000Z');
    expect(parseIcsDate('20260908T090000Z')?.toISOString()).toBe('2026-09-08T09:00:00.000Z');
    // Москва +3 круглый год: 12:00 местного — это 09:00 UTC
    expect(parseIcsDate('20260908T120000', { TZID: 'Europe/Moscow' })?.toISOString())
      .toBe('2026-09-08T09:00:00.000Z');
    // летнее время Берлина: в сентябре +2
    expect(parseIcsDate('20260908T120000', { TZID: 'Europe/Berlin' })?.toISOString())
      .toBe('2026-09-08T10:00:00.000Z');
    expect(parseIcsDate('когда-нибудь')).toBeNull();
  });
});

describe('ics: события', () => {
  it('обычная встреча со временем, местом и экранированным текстом', () => {
    const events = parseIcs(CAL([
      'BEGIN:VEVENT',
      'UID:abc@google.com',
      'SUMMARY:Планёрка\\, короткая',
      'LOCATION:Переговорная 2',
      'DTSTART;TZID=Europe/Moscow:20260908T120000',
      'DTEND;TZID=Europe/Moscow:20260908T123000',
      'END:VEVENT',
    ].join('\r\n')), from, to);

    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('Планёрка, короткая');
    expect(events[0].location).toBe('Переговорная 2');
    expect(events[0].startsAt.toISOString()).toBe('2026-09-08T09:00:00.000Z');
    expect(events[0].allDay).toBe(false);
  });

  it('встреча на весь день длится сутки, даже если конца нет', () => {
    const events = parseIcs(CAL([
      'BEGIN:VEVENT', 'UID:day1', 'SUMMARY:Отпуск',
      'DTSTART;VALUE=DATE:20260910', 'END:VEVENT',
    ].join('\r\n')), from, to);
    expect(events[0].allDay).toBe(true);
    expect(events[0].endsAt.getTime() - events[0].startsAt.getTime()).toBe(24 * 3600_000);
  });

  it('отменённая встреча не показывается', () => {
    const events = parseIcs(CAL([
      'BEGIN:VEVENT', 'UID:x', 'SUMMARY:Отменили', 'STATUS:CANCELLED',
      'DTSTART:20260908T090000Z', 'DTEND:20260908T100000Z', 'END:VEVENT',
    ].join('\r\n')), from, to);
    expect(events).toEqual([]);
  });

  it('встреча вне окна не попадает в календарь', () => {
    const events = parseIcs(CAL([
      'BEGIN:VEVENT', 'UID:far', 'SUMMARY:В другом году',
      'DTSTART:20270908T090000Z', 'DTEND:20270908T100000Z', 'END:VEVENT',
    ].join('\r\n')), from, to);
    expect(events).toEqual([]);
  });
});

describe('ics: повторы', () => {
  it('ежедневная планёрка разворачивается во все дни окна, а не в один', () => {
    const events = parseIcs(CAL([
      'BEGIN:VEVENT', 'UID:daily', 'SUMMARY:Дейлик',
      'DTSTART:20260901T060000Z', 'DTEND:20260901T061500Z',
      'RRULE:FREQ=DAILY;COUNT=5', 'END:VEVENT',
    ].join('\r\n')), from, to);
    expect(events).toHaveLength(5);
    // у каждого повтора свой ключ: с одним UID они затирали бы друг друга
    expect(new Set(events.map((e) => e.uid)).size).toBe(5);
    expect(events[0].startsAt.toISOString()).toBe('2026-09-01T06:00:00.000Z');
    expect(events[4].startsAt.toISOString()).toBe('2026-09-05T06:00:00.000Z');
  });

  it('«по вторникам и четвергам» — только эти дни', () => {
    const days = expandRrule(
      new Date('2026-09-01T07:00:00Z'), // вторник
      'FREQ=WEEKLY;BYDAY=TU,TH',
      from, new Date('2026-09-15T00:00:00Z'),
    );
    const weekdays = [...new Set(days.map((d) => d.getUTCDay()))].sort();
    expect(weekdays).toEqual([2, 4]);
    expect(days.every((d) => d.getUTCHours() === 7)).toBe(true);
  });

  it('UNTIL и COUNT обрывают повтор', () => {
    expect(expandRrule(new Date('2026-09-01T06:00:00Z'), 'FREQ=DAILY;UNTIL=20260903T235959Z', from, to)).toHaveLength(3);
    expect(expandRrule(new Date('2026-09-01T06:00:00Z'), 'FREQ=DAILY;COUNT=2', from, to)).toHaveLength(2);
  });

  it('шаг в две недели и месячный повтор', () => {
    expect(expandRrule(new Date('2026-09-01T06:00:00Z'), 'FREQ=WEEKLY;INTERVAL=2', from, to)).toHaveLength(3);
    const monthly = expandRrule(new Date('2026-09-05T06:00:00Z'), 'FREQ=MONTHLY', from, new Date('2026-12-01T00:00:00Z'));
    expect(monthly.map((d) => d.toISOString().slice(0, 10))).toEqual(['2026-09-05', '2026-10-05', '2026-11-05']);
  });

  it('исключённый день выпадает из повтора', () => {
    const events = parseIcs(CAL([
      'BEGIN:VEVENT', 'UID:daily2', 'SUMMARY:Дейлик',
      'DTSTART:20260901T060000Z', 'DTEND:20260901T061500Z',
      'RRULE:FREQ=DAILY;COUNT=3',
      'EXDATE:20260902T060000Z',
      'END:VEVENT',
    ].join('\r\n')), from, to);
    expect(events.map((e) => e.startsAt.toISOString().slice(0, 10))).toEqual(['2026-09-01', '2026-09-03']);
  });

  it('незнакомое правило не выдумывается: встреча приезжает одним разом', () => {
    expect(expandRrule(new Date('2026-09-01T06:00:00Z'), 'FREQ=HOURLY', from, to)).toHaveLength(1);
  });
});
