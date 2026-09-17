import { describeAction, isUndoable, validAction } from './support-actions';

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
});
