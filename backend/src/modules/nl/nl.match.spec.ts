import { matchUserInText, normalizeDeadline } from './nl.match';

const USERS = [
  { id: '2', name: 'Сергей Попович' },
  { id: '95', name: 'Юрий Про' },
  { id: '96', name: 'Глеб' },
  { id: '118', name: 'Константин' },
  { id: '119', name: 'Алина' },
  { id: '115', name: 'lee030303@gmail.com' },
];

describe('NL — исполнитель по имени в тексте', () => {
  it('узнаёт имя в косвенном падеже', () => {
    // именно эта команда создала ничью задачу
    expect(matchUserInText('Поставить на Константина задачу - не делать задачи с дедлайном на вчера', USERS)).toBe('118');
    expect(matchUserInText('поручи Алине посчитать смету', USERS)).toBe('119');
    expect(matchUserInText('задача для Глеба: обновить прайс', USERS)).toBe('96');
    expect(matchUserInText('на Юрия повесить созвон с клиентом', USERS)).toBe('95');
  });

  it('узнаёт по фамилии и в именительном падеже', () => {
    expect(matchUserInText('Попович готовит отчёт', USERS)).toBe('2');
    expect(matchUserInText('Константин смотрит логи', USERS)).toBe('118');
  });

  it('молчит, когда имени нет или оно неоднозначно', () => {
    expect(matchUserInText('сделать лендинг к пятнице', USERS)).toBeNull();
    expect(matchUserInText('', USERS)).toBeNull();
    // двое подходящих — выбирать за человека нельзя
    expect(matchUserInText('Глеб и Алина делают вместе', USERS)).toBeNull();
  });

  it('не подставляет срок в прошлом', () => {
    const today = '2026-08-17';
    // из-за этого задача заводилась уже просроченной
    expect(normalizeDeadline('2026-08-16', today)).toBeNull();
    expect(normalizeDeadline('2025-01-01', today)).toBeNull();
    expect(normalizeDeadline(today, today)).toBe(today); // сегодня — нормальный срок
    expect(normalizeDeadline('2026-08-25', today)).toBe('2026-08-25');
    expect(normalizeDeadline(null, today)).toBeNull();
    expect(normalizeDeadline('завтра', today)).toBeNull(); // модель обязана вернуть дату, а не слово
  });

  it('не цепляется за случайные короткие совпадения', () => {
    expect(matchUserInText('про это писать не надо', [{ id: '1', name: 'Про' }])).toBeNull();
    expect(matchUserInText('обсудить на неделе', USERS)).toBeNull();
  });
});
