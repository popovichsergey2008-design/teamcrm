import {
  blocksToChecklist, blocksToMarkdown, pageHash, pageLabels, pagePriority, pageStatus,
  pageTitle, pickProperty, pickStatusProperty, pickTitleProperty, plain, statusOptions,
} from './notion.map';
import type { NoDatabase, NoPage } from './notion.client';

/**
 * Разбор Notion ошибается молча и целиком: не то свойство взято за статус — и доска
 * получается с колонками из имён заказчиков; наивное чтение текста — и описания
 * обрываются на первом жирном слове.
 */

const db = (properties: Record<string, any>): NoDatabase => ({
  id: 'db1', title: [{ plain_text: 'Задачи команды' }], properties,
});

describe('Notion: какое свойство брать за статус', () => {
  it('тип status главнее названия и select', () => {
    const d = db({
      'Заказчик': { id: 'a', type: 'select' },
      'Этап': { id: 'b', type: 'status' },
    });
    expect(pickStatusProperty(d)).toBe('Этап');
  });

  it('без типа status берём select С ПОДХОДЯЩИМ названием, а не первый попавшийся', () => {
    const d = db({
      'Заказчик': { id: 'a', type: 'select' },
      'Статус': { id: 'b', type: 'select' },
    });
    expect(pickStatusProperty(d)).toBe('Статус');
  });

  it('нет ни того ни другого — колонок не будет, и это честнее случайного свойства', () => {
    expect(pickStatusProperty(db({ 'Текст': { id: 'a', type: 'rich_text' } }))).toBeNull();
  });

  it('название страницы — всегда свойство типа title', () => {
    expect(pickTitleProperty(db({ 'Имя': { id: 'a', type: 'title' } }))).toBe('Имя');
    expect(pickProperty(db({ 'Срок': { id: 'b', type: 'date' } }), 'date', /срок|due/i)).toBe('Срок');
  });
});

describe('Notion: колонки из вариантов статуса', () => {
  const d = db({
    'Этап': {
      id: 'b', type: 'status',
      status: {
        options: [
          { id: 'o1', name: 'Новые' },
          { id: 'o2', name: 'В работе' },
          { id: 'o3', name: 'Готово' },
        ],
        groups: [
          { id: 'g1', name: 'To-do', option_ids: ['o1'] },
          { id: 'g2', name: 'In progress', option_ids: ['o2'] },
          { id: 'g3', name: 'Complete', option_ids: ['o3'] },
        ],
      },
    },
  });

  it('порядок вариантов сохраняется, завершающая группа помечается', () => {
    expect(statusOptions(d, 'Этап')).toEqual([
      { name: 'Новые', done: false },
      { name: 'В работе', done: false },
      { name: 'Готово', done: true },
    ]);
  });

  it('без групп «готово» узнаётся по названию варианта', () => {
    const plainSelect = db({ 'Статус': { id: 'a', type: 'select', select: { options: [{ id: 'x', name: 'Выполнено' }] } } });
    expect(statusOptions(plainSelect, 'Статус')).toEqual([{ name: 'Выполнено', done: true }]);
  });

  it('свойства нет — колонок нет', () => {
    expect(statusOptions(d, null)).toEqual([]);
  });
});

describe('Notion: значения страницы', () => {
  const page: NoPage = {
    id: 'p1',
    properties: {
      'Имя': { type: 'title', title: [{ plain_text: 'Сверстать ' }, { plain_text: 'лендинг' }] },
      'Этап': { type: 'status', status: { name: 'В работе' } },
      'Метки': { type: 'multi_select', multi_select: [{ name: 'фронт', color: 'blue' }, { name: '', color: 'red' }] },
      'Приоритет': { type: 'select', select: { name: 'Срочно' } },
    },
  };

  it('текст склеивается из кусочков: форматирование не должно обрывать название', () => {
    expect(pageTitle(page, 'Имя')).toBe('Сверстать лендинг');
    expect(plain([{ plain_text: 'a' }, { plain_text: 'b' }])).toBe('ab');
    expect(plain(undefined)).toBe('');
  });

  it('название находится даже без известного свойства', () => {
    expect(pageTitle(page, 'Нет такого')).toBe('Сверстать лендинг');
    expect(pageTitle({ id: 'x', properties: {} }, null)).toBe('Без названия');
  });

  it('статус, метки и приоритет', () => {
    expect(pageStatus(page, 'Этап')).toBe('В работе');
    expect(pageLabels(page, 'Метки')).toEqual(['фронт']); // пустая метка не переносится
    expect(pagePriority(page, 'Приоритет')).toBe('urgent');
    expect(pagePriority(page, null)).toBe('normal');
  });
});

describe('Notion: страница → описание и чек-лист', () => {
  const blocks = [
    { id: '1', type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Что сделать' }] } },
    { id: '2', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Главная и контакты' }] } },
    { id: '3', type: 'to_do', to_do: { rich_text: [{ plain_text: 'Собрать макет' }], checked: true } },
    { id: '4', type: 'to_do', to_do: { rich_text: [{ plain_text: 'Отдать в вёрстку' }], checked: false } },
    { id: '5', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: 'Пункт' }] } },
  ];

  it('текст переносится Markdown’ом, а пункты дел — в чек-лист, а не в текст', () => {
    const md = blocksToMarkdown(blocks);
    expect(md).toContain('## Что сделать');
    expect(md).toContain('Главная и контакты');
    expect(md).toContain('- Пункт');
    expect(md).not.toContain('Собрать макет'); // это чек-лист, в описании ему не место

    expect(blocksToChecklist(blocks)).toEqual([
      { text: 'Собрать макет', done: true },
      { text: 'Отдать в вёрстку', done: false },
    ]);
  });

  it('пустая страница даёт пустое описание, а не строку из переводов строк', () => {
    expect(blocksToMarkdown([])).toBe('');
    expect(blocksToMarkdown([{ id: '1', type: 'paragraph', paragraph: { rich_text: [] } }])).toBe('');
  });
});

describe('Notion: хеш страницы', () => {
  const base = {
    title: 'Задача', description: 'текст', status: 'В работе', due: '2026-10-01',
    labels: ['фронт'], assignee: '7', checklist: [{ text: 'Раз', done: false }], archived: false,
  };

  it('не зависит от порядка меток', () => {
    expect(pageHash({ ...base, labels: ['фронт', 'бэк'] }))
      .toBe(pageHash({ ...base, labels: ['бэк', 'фронт'] }));
  });

  it('меняется от всего, что мы переносим', () => {
    const h = pageHash(base);
    expect(pageHash({ ...base, title: 'Другая' })).not.toBe(h);
    expect(pageHash({ ...base, status: 'Готово' })).not.toBe(h);
    expect(pageHash({ ...base, due: '2026-11-01' })).not.toBe(h);
    expect(pageHash({ ...base, assignee: '9' })).not.toBe(h);
    expect(pageHash({ ...base, archived: true })).not.toBe(h);
    expect(pageHash({ ...base, checklist: [{ text: 'Раз', done: true }] })).not.toBe(h);
  });
});
