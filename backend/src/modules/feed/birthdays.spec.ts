import { upcomingBirthdays } from './birthdays';

const row = (id: string, name: string, date: string) => ({
  id, full_name: name, avatar_file_id: null, birth_date: date,
});

describe('дни рождения в ленте компании', () => {
  it('сегодняшний именинник идёт первым, прошедшие в этом году ждут следующего', () => {
    const today = new Date('2026-09-08T09:00:00Z');
    const out = upcomingBirthdays([
      row('1', 'Пётр', '1990-09-08'),   // сегодня
      row('2', 'Анна', '1985-09-10'),   // послезавтра
      row('3', 'Игорь', '1979-09-01'),  // уже прошёл — не в ближайшие 30 дней
    ], today);

    expect(out.map((b) => b.fullName)).toEqual(['Пётр', 'Анна']);
    expect(out[0].inDays).toBe(0);
    expect(out[1].inDays).toBe(2);
    expect(out[0].date).toBe('2026-09-08');
  });

  it('29 февраля в невисокосный год поздравляем 28-го, а не теряем человека', () => {
    const out = upcomingBirthdays([row('1', 'Ася', '2000-02-29')], new Date('2026-02-01T00:00:00Z'));
    expect(out[0].date).toBe('2026-02-28');
    expect(out[0].inDays).toBe(27);

    const leap = upcomingBirthdays([row('1', 'Ася', '2000-02-29')], new Date('2028-02-01T00:00:00Z'));
    expect(leap[0].date).toBe('2028-02-29');
  });

  it('в декабре видно январских именинников — год переходит', () => {
    const out = upcomingBirthdays([row('1', 'Лена', '1992-01-03')], new Date('2026-12-28T23:00:00Z'));
    expect(out[0].date).toBe('2027-01-03');
    expect(out[0].inDays).toBe(6);
  });

  it('пустая и битая дата не роняют блок', () => {
    const out = upcomingBirthdays([
      { id: '1', full_name: 'Без даты', avatar_file_id: null, birth_date: 'не дата' },
    ], new Date('2026-09-08T00:00:00Z'));
    expect(out).toEqual([]);
  });
});
