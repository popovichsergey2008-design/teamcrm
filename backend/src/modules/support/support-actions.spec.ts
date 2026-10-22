import { actionButton, describeAction, isUndoable, normalizeProgress, progressLine, tasksWord, validAction } from './support-actions';

/**
 * Подпись действия — то, что человек читает перед кнопкой «Разрешить».
 *
 * Проверяем именно её: расплывчатое «поправлю настройку» — это не предложение, а
 * просьба довериться, и согласие на него ничего не стоит.
 */
describe('служба заботы: действия с разрешения человека', () => {
  it('в предложении видно последствие, а не намерение', () => {
    expect(describeAction({
      kind: 'task.deadline', entityId: '12', value: '2026-09-23T14:00:00.000Z',
      labels: { entity: 'Отчёт по неделе' },
    })).toContain('«Отчёт по неделе»');

    expect(describeAction({ kind: 'task.deadline', entityId: '12', value: null }))
      .toBe('Сниму срок у задачи #12.');

    expect(describeAction({
      kind: 'task.project', entityId: '12', value: '3', labels: { entity: 'Правки', value: 'КРИПТА' },
    })).toContain('Переписка, вложения и время переедут вместе с ней');

    // необратимое действие честно называет себя необратимым
    expect(describeAction({ kind: 'project.columns', entityId: '5', labels: { entity: 'Наём' } }))
      .toContain('Отменить это одной кнопкой не получится');
  });

  it('отмена обещается только там, где она есть', () => {
    expect(isUndoable('task.deadline')).toBe(true);
    expect(isUndoable('task.assignee')).toBe(true);
    expect(isUndoable('project.columns')).toBe(false);
  });

  it('непонятная просьба не становится предложением', () => {
    expect(validAction({ kind: 'task.assignee', entityId: '7', value: '' })).toBe(false);
    expect(validAction({ kind: 'task.project', entityId: '7' })).toBe(false);
    expect(validAction({ kind: 'сделай хорошо' as never, entityId: '7' })).toBe(false);
    expect(validAction({ kind: 'task.deadline', entityId: '7', value: null })).toBe(true);
  });

  it('ТЗ-34: на кнопке — само действие, как в документе', () => {
    expect(actionButton({ kind: 'meetings.autoprotocol' })).toBe('Включить автопротокол созвонов в 1 тап');
    expect(actionButton({ kind: 'import.confirm', params: { total: 450, project: 'Trello' } }))
      .toBe('Подтвердить импорт 450 задач в проект «Trello»');
    expect(actionButton({ kind: 'import.confirm', params: { total: 21, project: 'X' } }))
      .toBe('Подтвердить импорт 21 задачи в проект «X»');
    expect(describeAction({ kind: 'import.confirm', entityId: 'f1', params: { total: 3, fileName: 'план.xlsx', project: 'план' } }))
      .toContain('Перенесу 3 задачи из файла «план.xlsx» в новый проект «план»');
    expect(tasksWord(1)).toBe('1 задачу');
    expect(tasksWord(12)).toBe('12 задач');
    // импорт и колонки не отменяются одной кнопкой; автопротокол — выключается
    expect(isUndoable('import.confirm')).toBe(false);
    expect(isUndoable('meetings.autoprotocol')).toBe(true);
    expect(validAction({ kind: 'meetings.autoprotocol', entityId: 'me' })).toBe(true);
  });

  it('ТЗ-34: живой прогресс — в границах и дословной строкой', () => {
    expect(normalizeProgress({ text: '  ', percent: 50 })).toBeNull();
    expect(normalizeProgress({ text: 'переносит задачи', percent: 140, minutesLeft: 5 }))
      .toEqual({ text: 'переносит задачи', percent: 100, minutesLeft: 0 });
    expect(normalizeProgress({ text: 'x', percent: -3, minutesLeft: '' })).toEqual({ text: 'x', percent: 0, minutesLeft: null });
    const p = normalizeProgress({ text: 'переносит ваши 120 задач и создает папки проектов', percent: 85, minutesLeft: 2 })!;
    expect(progressLine('Максим Петров', p))
      .toBe('Инженер Максим переносит ваши 120 задач и создает папки проектов: готово 85% (осталось 2 мин). Пришлем тихий пуш по готовности');
  });
});
