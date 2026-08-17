import { matchNamed } from './meetings.service';

const PROJECTS = [
  { id: '1', name: 'Аэрос' },
  { id: '2', name: 'Сайт компании' },
  { id: '3', name: 'Крафт' },
];
const COLUMNS = [
  { id: '10', name: 'Новые' },
  { id: '11', name: 'Тексты' },
  { id: '12', name: 'В работе' },
  { id: '13', name: 'Готово' },
];

describe('проект и колонка по названию из речи', () => {
  it('точное совпадение', () => {
    expect(matchNamed(PROJECTS, 'Аэрос')?.id).toBe('1');
    expect(matchNamed(COLUMNS, 'Тексты')?.id).toBe('11');
  });

  it('регистр и падеж не мешают', () => {
    // именно так это и звучит на встрече
    expect(matchNamed(COLUMNS, 'тексты')?.id).toBe('11');
    expect(matchNamed(COLUMNS, 'в колонку Тексты')?.id).toBe('11');
    expect(matchNamed(PROJECTS, 'сайт компании')?.id).toBe('2');
  });

  it('молчит, когда совпадения нет или их несколько', () => {
    expect(matchNamed(COLUMNS, 'Бэклог')).toBeNull();
    expect(matchNamed(PROJECTS, null)).toBeNull();
    expect(matchNamed(PROJECTS, '')).toBeNull();
    // «работа» подходит и к «В работе», и к «Готово к работе» — выбирать нельзя
    expect(matchNamed([{ id: '1', name: 'В работе' }, { id: '2', name: 'Готово к работе' }], 'работе')).toBeNull();
  });

  it('короткий обрывок речи не считается названием', () => {
    expect(matchNamed(COLUMNS, 'в')).toBeNull();
  });
});
