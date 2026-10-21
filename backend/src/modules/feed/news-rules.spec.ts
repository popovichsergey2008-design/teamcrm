import {
  cleanPollOptions, DayFacts, highlightReason, highlightText, learningsText, pickHero, pollWinner,
  radarText, sensitiveHint, weekTrend,
} from './news-rules';

const base: DayFacts = {
  date: '2026-10-10', completedTasks: 0, projectsAffected: 0, topTasks: [], meetingsCount: 0, meetingsMinutes: 0,
  decisions: 0, releases: [], kudos: [], blockersResolved: 0, weekClosed: 0, prevWeekClosed: 0, criticalClosers: [],
};

describe('хайлайт дня', () => {
  it('день без повода — пропуск', () => {
    expect(highlightReason({ ...base, completedTasks: 4 })).toBeNull();
  });
  it('16 закрытых задач — повод, цифры из фактов', () => {
    const f = { ...base, completedTasks: 16, projectsAffected: 3, meetingsCount: 4, meetingsMinutes: 42 };
    expect(highlightReason(f)).toBe('tasks');
    const t = highlightText(f, null);
    expect(t.title).toBe('AI-хайлайты дня');
    expect(t.body).toContain('Вчера: закрыто 16 задач в 3 проектах.');
    expect(t.body).toContain('Проведено 4 созвона общей длительностью 42 мин.');
  });
  it('релиз — повод даже при двух задачах, и ссылка на пост релиза', () => {
    const f = { ...base, completedTasks: 2, releases: [{ postId: '7', title: 'Гостевые ссылки' }] };
    expect(highlightReason(f)).toBe('release');
    const t = highlightText(f, null);
    expect(t.body).toContain('Главный прорыв: «Гостевые ссылки»');
    expect(t.sources).toContainEqual({ label: 'Гостевые ссылки', path: '/news/7' });
  });
  it('рост скорости показываем только заметный, спад — нет', () => {
    expect(weekTrend(23, 20)).toBe('Команда работает на 15% быстрее, чем на прошлой неделе.');
    expect(weekTrend(18, 20)).toBeNull();
    expect(weekTrend(6, 3)).toBeNull(); // мало данных
  });
});

describe('герой дня', () => {
  it('по благодарностям и критичным задачам', () => {
    const h = pickHero({ ...base, kudos: [{ toUserId: '1', toName: 'Глеб' }], criticalClosers: [{ userId: '1', name: 'Глеб', count: 1 }] });
    expect(h?.name).toBe('Глеб');
  });
  it('одна задача без благодарностей — не повод', () => {
    expect(pickHero({ ...base, criticalClosers: [{ userId: '1', name: 'Глеб', count: 1 }] })).toBeNull();
  });
  it('ничья — героя нет', () => {
    expect(pickHero({ ...base, kudos: [{ toUserId: '1', toName: 'А' }, { toUserId: '2', toName: 'Б' }] })).toBeNull();
  });
  it('#1526: явный лидер по закрытым задачам — герой', () => {
    const h = pickHero({ ...base, closers: [
      { userId: '1', name: 'Глеб', count: 5, topTitle: 'Вёрстка гостевой страницы' },
      { userId: '2', name: 'Аня', count: 2, topTitle: 'x' },
    ] });
    expect(h?.name).toBe('Глеб');
    expect(h?.why).toBe('закрыто 5 задач, в том числе «Вёрстка гостевой страницы»');
  });
  it('#1526: две задачи или равенство — не лидер', () => {
    expect(pickHero({ ...base, closers: [{ userId: '1', name: 'Глеб', count: 2, topTitle: 'x' }] })).toBeNull();
    expect(pickHero({ ...base, closers: [{ userId: '1', name: 'А', count: 4, topTitle: 'x' }, { userId: '2', name: 'Б', count: 4, topTitle: 'y' }] })).toBeNull();
  });
});

describe('релиз-радар', () => {
  it('пункты, «ещё N» и авторы', () => {
    const tasks = Array.from({ length: 8 }, (_, i) => ({ id: String(i), title: `Задача ${i}`, description: null, assigneeName: null }));
    const r = radarText('QEVO', tasks, ['Сергей Попович', 'Boris Chest']);
    expect(r.title).toBe('Релиз-радар: «QEVO»');
    expect(r.body).toContain('• Задача 0.');
    expect(r.body).toContain('…и ещё 2 изменения.');
    expect(r.body).toContain('Авторы: Сергей Попович, Boris Chest. Поздравляем!');
  });
});

describe('выводы недели', () => {
  it('мало материала — пропуск', () => {
    expect(learningsText({ decisions: [{ text: 'x', path: '/a' }], meetings: [], releases: [], blockersResolved: 0, kudosCount: 0, closedTasks: 3 })).toBeNull();
  });
  it('каждая строка со ссылкой', () => {
    const w = learningsText({
      decisions: [{ text: 'Ретро по пятницам в 17:00', path: '/chat/5' }],
      meetings: [], releases: [{ title: 'Гостевые ссылки', path: '/news/7' }],
      blockersResolved: 3, kudosCount: 4, closedTasks: 20,
    });
    expect(w?.body).toContain('Вышло: «Гостевые ссылки»');
    expect(w?.body).toContain('За неделю закрыто 20 задач, благодарностей: 4.');
    expect(w?.sources.length).toBe(2);
  });
});

describe('опросы и модерация', () => {
  it('варианты чистятся и проверяются', () => {
    expect(cleanPollOptions(['16:00', ' 16:00 ', ''])).toBe('Нужно минимум два разных варианта');
    expect(cleanPollOptions(['16:00', '17:00'])).toEqual(['16:00', '17:00']);
  });
  it('победитель и ничья', () => {
    expect(pollWinner([{ optionId: '1', label: '16:00', votes: 2 }, { optionId: '2', label: '17:00', votes: 5 }])).toEqual({ label: '17:00' });
    expect(pollWinner([{ optionId: '1', label: 'A', votes: 2 }, { optionId: '2', label: 'B', votes: 2 }])).toEqual({ tie: ['A', 'B'] });
    expect(pollWinner([{ optionId: '1', label: 'A', votes: 0 }])).toBeNull();
  });
  it('пароль и карта в тексте', () => {
    expect(sensitiveHint('пароль: qwerty123')).toContain('пароль');
    expect(sensitiveHint('карта 4111 1111 1111 1111')).toContain('карты');
    expect(sensitiveHint('встреча в 17:00')).toBeNull();
  });
});
