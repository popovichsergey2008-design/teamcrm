import { isDoneColumn, pickDoneColumn } from './task-columns';

describe('колонка «готово»', () => {
  it('узнаёт разные написания, включая регистр и пробелы', () => {
    for (const n of ['Done', 'готово', 'ГОТОВО', ' Выполнено ', 'Завершено', 'Завершён', 'Закрыто', 'Сделано']) {
      expect(isDoneColumn(n)).toBe(true);
    }
  });

  it('не принимает за «готово» рабочие колонки', () => {
    // именно здесь копились закрытые задачи
    for (const n of ['Пауза', 'В работе', 'На тестировании', 'Новые', 'Готовится', 'Не готово']) {
      expect(isDoneColumn(n)).toBe(false);
    }
  });

  it('выбирает первую подходящую колонку и молчит, когда её нет', () => {
    const cols = [
      { id: '1', name: 'Новые' },
      { id: '2', name: 'Пауза' },
      { id: '3', name: 'Готово' },
      { id: '4', name: 'Done' },
    ];
    expect(pickDoneColumn(cols)?.id).toBe('3');
    expect(pickDoneColumn([{ id: '1', name: 'Пауза' }])).toBeNull();
    expect(pickDoneColumn([])).toBeNull();
  });
});
