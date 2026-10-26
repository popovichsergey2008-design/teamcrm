import { editSplit, SplitItem } from './chat-task-draft.service';

const item = (o: Partial<SplitItem>): SplitItem => ({
  title: 'Задача', description: null, assigneeId: null, deadline: null, checklist: [], priority: 'normal', ...o,
});

describe('правка разложенных поручений (#4645)', () => {
  const was = [item({ title: 'Поправить тарифы', assigneeId: '8', deadline: '2026-10-30' }), item({ title: 'Проверить форму' })];

  it('человек правит название, исполнителя и срок — остальное не теряется', () => {
    const r = editSplit(was, [
      { title: '  Тарифы: кнопка под ценой ', assigneeId: '9', deadline: '2026-11-06' },
      { title: 'Проверить форму', assigneeId: null, deadline: null },
    ]);
    expect(r).toEqual([
      item({ title: 'Тарифы: кнопка под ценой', assigneeId: '9', deadline: '2026-11-06' }),
      item({ title: 'Проверить форму' }),
    ]);
  });

  it('пустое название оставляет прежнее, кривой срок сбрасывается', () => {
    const r = editSplit(was, [{ title: '   ', deadline: 'пятница' }, {}]);
    expect(r?.[0]).toMatchObject({ title: 'Поправить тарифы', deadline: null, assigneeId: '8' });
    expect(r?.[1]).toEqual(was[1]);
  });

  it('уже созданный пункт не трогаем, другой состав не принимаем', () => {
    const done = [item({ title: 'Создана', taskId: '501' }), item({ title: 'Нет' })];
    expect(editSplit(done, [{ title: 'Другое' }, { title: 'Да' }])).toEqual([done[0], item({ title: 'Да' })]);
    expect(editSplit(was, [{ title: 'одна' }])).toBeNull();
    expect(editSplit(undefined, [{ title: 'x' }])).toBeNull();
  });
});
