import { briefDue, CoffeeFacts, decisionLine, hotLine, morningCoffee, standupDrafts, supportLine } from './morning-rules';

const empty: CoffeeFacts = {
  name: 'Борис Петров', decisions: [], hot: [], hotTotal: 0, overdue: 0, support: null,
  waiting: { proposals: 0, approvals: 0 }, meetingsToday: 0, firstMeeting: null, overloaded: [], drafts: 0,
};

describe('утренний аудио-кофе (#1525)', () => {
  it('пример из документа — слово в слово по форме', () => {
    const c = morningCoffee({
      ...empty,
      decisions: [{ text: 'Структуру гостевых ссылок', peer: 'Сергей Попович', meetingTitle: 'Планерка' }],
      hot: [{ title: 'Верстка', who: 'Глеб Иванов' }], hotTotal: 1,
      support: { total: 5, closed: 5 },
      drafts: 3,
    });
    expect(c.intro).toBe('Доброе утро, Борис! На связи ваш ассистент QEVO. Вот главное на сегодня:');
    expect(c.items).toEqual([
      'Вчера на созвоне с Сергеем согласовали структуру гостевых ссылок.',
      'Сегодня горящий дедлайн у Глеба по задаче «Верстка».',
      'В техподдержке закрыты все 100 процентов вопросов.',
    ]);
    expect(c.outro).toBe('Черновики для утренней планерки я уже добавил в ваши задачи. Хорошего дня!');
    expect(c.speech).toBe('Доброе утро, Борис! На связи ваш ассистент QEVO. Вот главное на сегодня: Вчера на созвоне с Сергеем согласовали структуру гостевых ссылок. '
      + 'Сегодня горящий дедлайн у Глеба по задаче Верстка. В техподдержке закрыты все 100 процентов вопросов. '
      + 'Черновики для утренней планерки я уже добавил в ваши задачи. Хорошего дня!');
  });

  it('без черновиков — фразу о них не говорим; пусто — «ничего не горит»', () => {
    const c = morningCoffee(empty);
    expect(c.items).toEqual(['Ничего не горит: сроков на сегодня и ждущих решений нет.']);
    expect(c.outro).toBe('Хорошего дня!');
    expect(morningCoffee({ ...empty, name: null }).intro).toBe('Доброе утро! На связи ваш ассистент QEVO. Вот главное на сегодня:');
  });

  it('решение-глагол, без собеседника; горит без исполнителя; женские имена', () => {
    expect(decisionLine({ text: 'Решено: заложить комиссию 2.5 процента в договор', peer: 'Константин', meetingTitle: null }))
      .toBe('Вчера на созвоне с Константином решили заложить комиссию 2.5 процента в договор.');
    expect(decisionLine({ text: 'Дизайн утверждён', peer: null, meetingTitle: 'Клиент Альфа' }))
      .toBe('Вчера на созвоне «Клиент Альфа» согласовали дизайн утверждён.');
    expect(hotLine({ title: 'Смета', who: null })).toBe('Сегодня горящий дедлайн по задаче «Смета».');
    expect(hotLine({ title: 'Смета', who: 'Анна Смирнова' })).toBe('Сегодня горящий дедлайн у Анны по задаче «Смета».');
    expect(decisionLine({ text: 'Правки до среды', peer: 'Мария', meetingTitle: null })).toBe('Вчера на созвоне с Марией согласовали правки до среды.');
  });

  it('служба заботы: проценты и склонение; нет обращений — пункта нет', () => {
    expect(supportLine({ total: 5, closed: 4 })).toBe('В техподдержке закрыты 80 процентов вопросов.');
    expect(supportLine({ total: 3, closed: 2 })).toBe('В техподдержке закрыты 67 процентов вопросов.');
    expect(supportLine({ total: 100, closed: 1 })).toBe('В техподдержке закрыты 1 процент вопросов.');
    expect(supportLine({ total: 0, closed: 0 })).toBeNull();
    expect(supportLine(null)).toBeNull();
  });

  it('не больше восьми пунктов и ~45 секунд', () => {
    const c = morningCoffee({
      ...empty,
      decisions: [1, 2, 3].map((i) => ({ text: `решение номер ${i} про очень длинный и подробный договор с банком`, peer: 'Сергей', meetingTitle: null })),
      hot: [1, 2, 3].map((i) => ({ title: `Задача ${i}`, who: 'Глеб' })), hotTotal: 5, overdue: 4,
      support: { total: 4, closed: 3 }, waiting: { proposals: 2, approvals: 1 }, meetingsToday: 3,
      firstMeeting: { title: 'Планерка', time: '10:00' }, overloaded: ['Глеб Иванов', 'Анна'], drafts: 2,
    });
    expect(c.items.length).toBeLessThanOrEqual(8);
    expect(c.speech.split(/\s+/).length).toBeLessThanOrEqual(110);
    expect(c.items[0]).toMatch(/^Вчера на созвоне с Сергеем/);
    expect(c.items).toContain('Ещё 3 срока у команды тоже сегодня.');
  });

  it('черновики планерки: горящее, блокеры, решения; без проекта — нет; без дублей', () => {
    const d = standupDrafts({
      tasks: [{ id: '7', projectId: '1', title: 'Верстка', who: 'Глеб Иванов', overdue: false }, { id: '8', projectId: '1', title: 'Смета', who: null, overdue: true }],
      blocked: [{ id: '7', projectId: '1', title: 'Верстка', who: 'Глеб' }, { id: '9', projectId: '2', title: 'API банка', who: 'Анна' }],
      decisions: [{ id: '5', projectId: '1', text: 'Структура ссылок', meetingId: '3', meetingTitle: 'Планерка' }, { id: '6', projectId: null, text: 'Без проекта', meetingId: null, meetingTitle: null }],
    });
    expect(d.map((x) => x.ref)).toEqual(['task:7', 'task:8', 'task:9', 'decision:5']);
    expect(d[0].title).toBe('Планерка: срок сегодня «Верстка» — Глеб');
    expect(d[1].title).toBe('Планерка: просрочено «Смета»');
    expect(d[2].title).toBe('Планерка: снять блокер «API банка» — Анна');
    expect(d[3].title).toBe('Планерка: проверить исполнение решения «Структура ссылок»');
    expect(d.every((x) => x.taskId === null)).toBe(true);
  });
});

describe('время брифа', () => {
  it('9:00 по умолчанию: с 9:00 и до 13:00, выходные — нет; выключен — никогда', () => {
    expect(briefDue('09:00', { hour: 8, minute: 59, dow: 2 }, true)).toBe(false);
    expect(briefDue('09:00', { hour: 9, minute: 0, dow: 2 }, true)).toBe(true);
    expect(briefDue('09:00', { hour: 12, minute: 59, dow: 2 }, true)).toBe(true);
    expect(briefDue('09:00', { hour: 13, minute: 0, dow: 2 }, true)).toBe(false);
    expect(briefDue('09:00', { hour: 9, minute: 30, dow: 6 }, true)).toBe(false);
    expect(briefDue('09:00', { hour: 9, minute: 30, dow: 6 }, false)).toBe(true);
    expect(briefDue(null, { hour: 9, minute: 30, dow: 2 }, true)).toBe(false);
    expect(briefDue('07:30', { hour: 7, minute: 45, dow: 1 }, true)).toBe(true);
  });
});

describe('правки 27.10 (#1525)', () => {
  it('«все 100 процентов» — только когда закрыто всё', () => {
    expect(supportLine({ total: 200, closed: 199 })).toBe('В техподдержке закрыты 99 процентов вопросов.');
    expect(supportLine({ total: 3, closed: 3 })).toBe('В техподдержке закрыты все 100 процентов вопросов.');
  });

  it('длинное решение режется по слову, без «,….»', () => {
    const line = decisionLine({
      text: 'Переделать интерактивный блок на лендинге: симулировать одну задачу с отображением каждого этапа (постановка, исполнение, проверка, сдача, оплата)',
      peer: 'Boris', meetingTitle: null,
    });
    expect(line.endsWith('…')).toBe(true);
    expect(line).not.toMatch(/[,(]…|…\.$/u);
  });
});
