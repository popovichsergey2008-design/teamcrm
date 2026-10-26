import {
  cardByRules, cardFromModel, cardText, deadlineIso, deadlineLabel, exampleCard, EXAMPLE_PHRASE, imperativeToInfinitive, pickTime,
} from './bot-demo-rules';

// понедельник, 26.10.2026
const NOW = new Date(2026, 9, 26, 10, 0);

describe('карточка демо правилами (#4619)', () => {
  it('фраза из ТЗ: исполнитель, срок, проект, чек-лист', () => {
    const c = cardByRules(EXAMPLE_PHRASE, NOW)!;
    expect(c.title).toBe('Подготовить отчет по рекламе');
    expect(c.assignee).toBe('Дмитрий');
    expect(c.deadline).toBe('2026-10-30');
    expect(c.time).toBe('15:00');
    expect(c.project).toBe('Маркетинг и аналитика');
    expect(c.checklist.length).toBeGreaterThanOrEqual(3);
    expect(c.checklist.length).toBeLessThanOrEqual(5);
    expect(c.checklist).toContain('Добавить сравнение с прошлым месяцем');
  });

  it('без исполнителя — делает сам, без срока — «не указан»', () => {
    const c = cardByRules('нужно обновить логотип на сайте', NOW)!;
    expect(c.assignee).toBeNull();
    expect(c.title).toBe('Обновить логотип на сайте');
    expect(deadlineLabel(c, NOW)).toBe('не указан');
    expect(cardText(c, 50, NOW)).toContain('вы получили бы уведомление');
  });

  it('«Итак,» — не имя; пустая фраза — null', () => {
    expect(cardByRules('Итак, подготовь договор для клиента завтра', NOW)!.assignee).toBeNull();
    expect(cardByRules('ок', NOW)).toBeNull();
    expect(cardByRules('👍👍', NOW)).toBeNull();
    expect(cardByRules('привет', NOW)).toBeNull();
    expect(cardByRules('Спасибо, понял', NOW)).toBeNull();
    expect(cardByRules('Логотип', NOW)).toBeNull();
  });

  it('повелительное → инфинитив', () => {
    expect(imperativeToInfinitive('подготовь')).toBe('подготовить');
    expect(imperativeToInfinitive('Пришлите')).toBe('прислать');
    expect(imperativeToInfinitive('согласуй')).toBe('согласовать');
    expect(imperativeToInfinitive('позвони')).toBe('позвонить');
    expect(imperativeToInfinitive('закажи')).toBe('заказать');
    expect(imperativeToInfinitive('свяжитесь')).toBe('связаться');
    expect(imperativeToInfinitive('отчет')).toBeNull();
  });

  it('время в разных записях', () => {
    expect(pickTime('к пятнице 15:00')).toBe('15:00');
    expect(pickTime('в 9.30 утра')).toBe('09:30');
    expect(pickTime('к 18 часам')).toBe('18:00');
    expect(pickTime('отчёт за 2025 год')).toBeNull();
  });

  it('готовый пример и подпись срока', () => {
    const c = exampleCard(NOW);
    expect(deadlineLabel(c, NOW)).toBe('Пятница, 15:00');
    expect(cardText(c, 1400, NOW)).toContain('Задача сформирована за 1,4 секунды!');
    expect(cardText(c, 1400, NOW)).toContain('Дмитрий получил бы уведомление');
    expect(deadlineIso(c)).toBe('2026-10-30T12:00:00.000Z');
  });
});

describe('карточка из ответа модели', () => {
  const rules = cardByRules(EXAMPLE_PHRASE, NOW);
  it('берёт поля модели, срок — от правил', () => {
    const c = cardFromModel(JSON.stringify({
      title: 'Подготовить отчёт по рекламе', assignee: 'Дмитрий', deadline: '2026-11-20', time: '10:00',
      project: 'Маркетинг', checklist: ['Собрать данные', 'Сравнить с прошлым месяцем', 'Сделать выводы'],
    }), rules, NOW)!;
    expect(c.deadline).toBe('2026-10-30');
    expect(c.time).toBe('15:00');
    expect(c.project).toBe('Маркетинг');
    expect(c.checklist).toHaveLength(3);
  });
  it('мусор — null; короткий чек-лист добивается шаблоном; прошедший срок модели отброшен', () => {
    expect(cardFromModel('не знаю', rules, NOW)).toBeNull();
    const c = cardFromModel('```json\n{"title":"Позвонить клиенту","deadline":"2020-01-01","checklist":["Позвонить"]}\n```', null, NOW)!;
    expect(c.deadline).toBeNull();
    expect(c.checklist.length).toBe(3);
    expect(c.assignee).toBeNull();
  });
});
