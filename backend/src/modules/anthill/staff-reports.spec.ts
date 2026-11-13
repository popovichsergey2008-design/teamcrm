import { csvNote, isReport, reportsText, sheetCsvUrl, summarize } from './staff-reports';

const at = new Date('2026-11-12T15:00:00Z');

describe('сводка отчётов сотрудников (#4893, п. 9)', () => {
  it('что считать отчётом', () => {
    expect(isReport({ body: 'сделал вёрстку', chatTitle: 'ОТЧЁТЫ' })).toBe(true);
    expect(isReport({ body: 'Отчёт за 12.11: …', chatTitle: null })).toBe(true);
    expect(isReport({ body: 'привет, как дела', chatTitle: 'Разработка' })).toBe(false);
  });
  it('по человеку: сделано, риски, таблицы; с рисками — первыми', () => {
    const people = summarize([
      { authorId: '1', author: 'Мария', body: 'Отчёт за вчера\n- сверстала лендинг\n- правки по шапке', chatTitle: 'ОТЧЁТЫ', at },
      { authorId: '2', author: 'Глеб', body: 'Отчёт\n1. API заказов\n2. Не успеваю с оплатой — жду ключи\nhttps://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWx/edit#gid=42', chatTitle: 'ОТЧЁТЫ', at },
    ]);
    expect(people[0].author).toBe('Глеб');
    expect(people[0].status).toBe('риски');
    expect(people[0].risks[0]).toContain('Не успеваю');
    expect(people[1].done).toEqual(['сверстала лендинг', 'правки по шапке']);
    expect(sheetCsvUrl(people[0].sheets[0])).toBe('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWx/export?format=csv&gid=42');
    const text = reportsText(people, ['Иван'], 'вчера', new Map());
    expect(text).toContain('прислали 2, не прислали 1');
    expect(text).toContain('Не прислали: Иван.');
    expect(text).toContain('доступа нет');
  });
  it('таблица — коротко', () => {
    expect(csvNote('Дата,Звонков,Встреч\n12.11,14,3\n13.11,9,2')).toBe('2 строк; колонки: Дата, Звонков, Встреч; последняя строка: 13.11 · 9 · 2');
  });
});
