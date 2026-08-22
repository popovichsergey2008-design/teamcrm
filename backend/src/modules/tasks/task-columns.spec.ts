import { isDoneColumn, isReviewColumn, pickDoneColumn } from './task-columns';

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

  it('отличает «проверку» от «готово» и от рабочих колонок', () => {
    for (const n of ['На тестировании', ' на проверке ', 'СОГЛАСОВАНИЕ', 'Review', 'QA', 'На приёмке']) {
      expect(isReviewColumn(n)).toBe(true);
    }
    // «Готово» — уже принято, решения не ждёт; «В работе» — ещё не сдано
    for (const n of ['Готово', 'Done', 'В работе', 'Новые', 'Пауза']) {
      expect(isReviewColumn(n)).toBe(false);
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
