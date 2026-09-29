import { alreadyCovered, chunks, cleanReasons, dailyDigest, DayStats, keyMessages, rate } from './daily-rules';

describe('уже разобрано', () => {
  it('узнаётся по ключевому сообщению того же вида', () => {
    const keys = keyMessages([{ messageId: '5', role: 'instruction' }, { messageId: '6', role: 'context' }]);
    expect(keys).toEqual(['5']);
    expect(alreadyCovered({ type: 'task', keys }, [{ type: 'task', messageIds: ['5', '9'] }])).toBe(true);
  });
  it('общий контекст — не повод считать повтором', () => {
    const keys = keyMessages([{ messageId: '7', role: 'instruction' }, { messageId: '6', role: 'context' }]);
    expect(alreadyCovered({ type: 'task', keys }, [{ type: 'task', messageIds: ['6'] }])).toBe(false);
  });
  it('поручение и его изменение друг друга не глушат', () => {
    expect(alreadyCovered({ type: 'change', keys: ['5'] }, [{ type: 'task', messageIds: ['5'] }])).toBe(false);
  });
  it('без ключевых ролей узнаём по всем источникам', () => {
    expect(keyMessages([{ messageId: '1', role: 'context' }, { messageId: '2', role: 'context' }])).toEqual(['1', '2']);
  });
});

describe('куски дня', () => {
  it('режутся по порядку и без потерь', () => {
    const r = chunks([1, 2, 3, 4, 5], 2);
    expect(r).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe('сводка дня', () => {
  const day: DayStats = {
    messages: 150, sourceMessages: 8, tasksCreated: 5, meetings: 1, decisions: 3, notes: 0, waiting: 2, clarifications: 1,
    chats: [
      { title: 'Разработка', created: ['#1421 Исправить API авторизации', 'Решение: релиз во вторник'], waiting: ['не определён исполнитель: «проверить мобильную версию»'] },
      { title: 'Пустой', created: [], waiting: [] },
    ],
  };

  it('короткая влезает в строку ассистента и говорит главное', () => {
    const d = dailyDigest(day)!;
    expect(d.short.length).toBeLessThanOrEqual(300);
    expect(d.short).toContain('5 задач, 1 встреча, 3 решения');
    expect(d.short).toContain('142 сообщения');
  });
  it('полная — по чатам, пустые чаты не перечисляет', () => {
    const d = dailyDigest(day)!;
    expect(d.long).toContain('• Разработка');
    expect(d.long).toContain('✓ #1421 Исправить API авторизации');
    expect(d.long).toContain('⚠ не определён исполнитель');
    expect(d.long).not.toContain('Пустой');
  });
  it('день без переписки — без сводки', () => {
    expect(dailyDigest({ ...day, messages: 0 })).toBeNull();
  });
  it('день без находок — честно говорит, что их нет', () => {
    const d = dailyDigest({ ...day, tasksCreated: 0, meetings: 0, decisions: 0, waiting: 0, clarifications: 0, chats: [] })!;
    expect(d.short).toContain('Новых задач и решений из переписки нет.');
  });
});

describe('качество', () => {
  it('причины — только известные, без повторов, у «верно» их нет', () => {
    expect(cleanReasons(false, ['wrong_assignee', 'wrong_assignee', 'чушь'])).toEqual(['wrong_assignee']);
    expect(cleanReasons(true, ['wrong_assignee'])).toEqual([]);
    expect(cleanReasons(false, 'wrong_project')).toEqual([]);
  });
  it('доля от нуля — пусто, а не ноль', () => {
    expect(rate(0, 0)).toBeNull();
    expect(rate(1, 4)).toBe(0.25);
  });
});
