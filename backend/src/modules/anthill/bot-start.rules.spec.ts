import { buildCards, inMonth, isStale, quadrantOf, weekMinutes, weekText } from './bot-start.rules';

const none = { meetings: 0, noAgenda: 0, firstNoAgenda: null, decisions: 0, needReply: 0, reports: 0, reportChats: [], project: null, members: 1 };

describe('стартовый экран бота (#4893, п. 1)', () => {
  it('только данные человека, не больше четырёх, без пустых', () => {
    const cards = buildCards({ ...none, meetings: 3, noAgenda: 1, firstNoAgenda: 'Планёрка', decisions: 27, needReply: 3, reports: 4 }, { mail: true, calendar: true, telegram: true });
    expect(cards.map((c) => c.text)).toEqual(['3 встречи сегодня — к одной нет повестки', '27 решений ждут вас', '3 сообщения ждут ответа', '4 отчёта сотрудников за вчера']);
    expect(cards.map((c) => c.button)).toEqual(['Подготовить', 'Разобрать за 15 мин', 'Что ответить', 'Свести в один']);
  });
  it('данных нет — первые шаги', () => {
    expect(buildCards(none, { mail: false, calendar: false, telegram: false }).map((c) => c.id)).toEqual(['voice', 'invite', 'calendar', 'mail']);
  });
  it('месяц в предложном', () => {
    expect([inMonth('октябрь'), inMonth('май'), inMonth('март')]).toEqual(['октябре', 'мае', 'марте']);
  });
});

describe('матрица Эйзенхауэра (п. 10)', () => {
  const now = new Date('2026-11-13T10:00:00Z');
  const t = (o: Partial<Parameters<typeof quadrantOf>[0]>) => ({ id: '1', title: 'x', projectName: null, deadlineAt: null, priority: null, updatedAt: now, blocksOthers: false, ...o });
  it('квадранты правилами', () => {
    expect(quadrantOf(t({ deadlineAt: new Date('2026-11-14T10:00:00Z'), priority: 'high' }), now)).toBe('do');
    expect(quadrantOf(t({ priority: 'high' }), now)).toBe('plan');
    expect(quadrantOf(t({ deadlineAt: new Date('2026-11-12T10:00:00Z') }), now)).toBe('delegate');
    expect(quadrantOf(t({ blocksOthers: true }), now)).toBe('plan');
    expect(quadrantOf(t({}), now)).toBe('drop');
    expect(isStale(t({ updatedAt: new Date('2026-09-01T00:00:00Z') }), now)).toBe(true);
  });
});

describe('бот за неделю (п. 11)', () => {
  it('числа и оценка времени', () => {
    const c = { summaries: 3, meetingTasks: 5, meetings: 2, mail: 0, tasks: 4, reminders: 1 };
    expect(weekMinutes(c)).toBe(30 + 20 + 10 + 12 + 1);
    expect(weekText(c)).toBe('Бот за неделю: 3 сводки · 5 задач из встреч · 2 встречи поставлены · 4 задачи поставлены · 1 напоминание. Это примерно 1 ч 13 мин вашего времени.');
  });
});
