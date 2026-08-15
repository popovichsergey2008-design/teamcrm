import { matchTeamMember } from './meetings.service';

describe('Встречи: имя со встречи → сотрудник', () => {
  const team = [
    { id: '1', full_name: 'Алина Гравитон' },
    { id: '2', full_name: 'Иван Петров' },
    { id: '3', full_name: 'Иван Сидоров' },
    { id: '4', full_name: 'Юрий Проценко' },
  ];

  it('точное совпадение и совпадение по имени', () => {
    expect(matchTeamMember(team, 'Иван Петров')).toBe('2');
    expect(matchTeamMember(team, 'Алина')).toBe('1');
    expect(matchTeamMember(team, 'проценко')).toBe('4'); // регистр не важен
  });

  it('при неоднозначности исполнителя не назначаем', () => {
    // двое Иванов: угадывать нельзя — задача уйдёт не тому, и это хуже пустого поля
    expect(matchTeamMember(team, 'Иван')).toBeNull();
  });

  it('незнакомое имя, пустое и слишком короткое → null', () => {
    expect(matchTeamMember(team, 'Владимир')).toBeNull();
    expect(matchTeamMember(team, null)).toBeNull();
    expect(matchTeamMember(team, ' ')).toBeNull();
    expect(matchTeamMember(team, 'И')).toBeNull();
  });

  it('ё и е считаются одной буквой', () => {
    expect(matchTeamMember([{ id: '9', full_name: 'Пётр Алексеев' }], 'Петр')).toBe('9');
  });
});
