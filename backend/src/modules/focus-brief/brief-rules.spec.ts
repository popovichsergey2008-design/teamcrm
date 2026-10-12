import { acceptPolish, BriefFacts, briefText, composeBrief, factsHash, listenLabel, presetFor, speechScript } from './brief-rules';

const base = (over: Partial<BriefFacts> = {}): BriefFacts => ({
  today: '2026-10-12', dayOff: false, boss: false, top: [], meetings: [], postcall: [], commitments: [], dueOutside: [],
  waiting: { proposals: 0, approvals: 0 }, meetingsToday: 0, firstMeeting: null, announcements: [], clients: null, team: null,
  ...over,
});
const item = (rank: number, title: string, deadlineDate: string | null = null, done = false) => ({
  itemId: String(rank), rank, kind: 'task' as const, title, taskId: `${rank}0`, projectId: '7', projectName: 'Мобилка', deadlineDate, done,
});

describe('composeBrief', () => {
  it('три задачи, две горят: главное — из тройки, итог «три действия ниже»', () => {
    const b = composeBrief(base({ top: [item(1, 'Проверить mobile join', '2026-10-12'), item(2, 'Ответить Acme', '2026-10-11'), item(3, 'Релиз')] }));
    const t = briefText(b);
    expect(t).toContain('Сегодня главное — «Проверить mobile join» и «Ответить Acme»: срок уже прошёл.');
    expect(t).toMatch(/Три главных действия — ниже\.$/);
    expect(b.mentions).toEqual(['task:10', 'task:20']);
    expect(b.sources.length).toBe(2);
  });

  it('одна важная задача — «одно главное действие», без добивания до трёх', () => {
    const t = briefText(composeBrief(base({ top: [item(1, 'Смета')] })));
    expect(t).toBe('Главное на сегодня — «Смета». Одно главное действие — ниже.');
  });

  it('пустой день — честно, без искусственной тройки (п. 72)', () => {
    const t = briefText(composeBrief(base()));
    expect(t).toContain('На сегодня критичных дедлайнов нет.');
    expect(t).toContain('не стал искусственно заполнять');
  });

  it('выходной — без делового стресса (п. 74)', () => {
    expect(briefText(composeBrief(base({ dayOff: true, waiting: { proposals: 3, approvals: 0 } }))))
      .toBe('Сегодня у вас выходной. Критичных событий нет.');
  });

  it('горящее вне тройки называется внешним, а не молчит (п. 18)', () => {
    const t = briefText(composeBrief(base({ top: [item(1, 'Релиз')], dueOutside: [{ taskId: '99', projectId: '7', title: 'Договор', overdue: true }] })));
    expect(t).toContain('в план не вошло');
  });

  it('обещание, неразобранные итоги и решения — с кнопками', () => {
    const b = composeBrief(base({
      top: [item(1, 'Релиз')],
      commitments: [{ id: '1', action: 'отправить договор', taskId: null, projectId: null, sourceLabel: 'Обещание в чате · 18:40', sourceLink: '/chat/5' }],
      postcall: [{ meetingId: '12', title: 'Планёрка' }],
      waiting: { proposals: 1, approvals: 1 },
    }));
    const t = briefText(b);
    expect(t).toContain('Вы обещали отправить договор — это ещё не закрыто.');
    expect(b.actions.map((a) => a.kind).sort()).toEqual(['decisions', 'postcall']);
    expect(b.sentences.length).toBeLessThanOrEqual(5);
  });

  it('коротко — не больше трёх предложений', () => {
    const b = composeBrief(base({
      top: [item(1, 'Релиз', '2026-10-12')],
      postcall: [{ meetingId: '12', title: 'Планёрка' }], waiting: { proposals: 2, approvals: 0 },
      firstMeeting: { id: '1', title: 'Acme', time: '10:00', minutesLeft: 20 }, meetingsToday: 2,
    }), 'short');
    expect(b.sentences.length).toBe(3);
  });

  it('встреча через 20 минут — с кнопкой открыть', () => {
    const b = composeBrief(base({ firstMeeting: { id: '1', title: 'Acme', time: '10:00', minutesLeft: 20 }, meetingsToday: 1 }));
    expect(briefText(b)).toContain('В 10:00 встреча «Acme» — через 20 минут.');
    expect(b.actions[0].kind).toBe('meeting');
  });

  it('сигналы команды — только если положены (руководителю)', () => {
    expect(presetFor(false, { teamSignals: true, clients: null })).toEqual({ teamSignals: false, clients: false });
    expect(presetFor(true, { teamSignals: null, clients: null })).toEqual({ teamSignals: true, clients: true });
    const t = briefText(composeBrief(base({ boss: true, team: { overloaded: [] }, top: [item(1, 'Релиз')] })));
    expect(t).toContain('По команде перегрузок нет.');
  });
});

describe('acceptPolish', () => {
  const rules = 'Сегодня главное — «Смета»: срок сегодня. От вас ждут 2 решения. Одно главное действие — ниже.';
  it('принимает переформулировку с теми же фактами', () => {
    expect(acceptPolish(rules, 'Главное сегодня — «Смета», срок истекает сегодня. Вашего решения ждут 2 вопроса. Действие — ниже.')).toBe(true);
  });
  it('отклоняет новое число, новое название и восклицания', () => {
    expect(acceptPolish(rules, 'Главное — «Смета». Ждут 3 решения.')).toBe(false);
    expect(acceptPolish(rules, 'Главное — «Отчёт». Ждут 2 решения.')).toBe(false);
    expect(acceptPolish(rules, 'Отличный день! «Смета», 2 решения.')).toBe(false);
  });
});

describe('голос и версия', () => {
  it('скрипт речи без кавычек, с приветствием по имени', () => {
    expect(speechScript('Борис Иванов', 'Главное — «Смета».', 9)).toBe('Доброе утро, Борис. Главное, Смета.');
  });
  it('подпись — по фактической длительности (п. 9)', () => {
    expect(listenLabel(42.4)).toBe('Прослушать · 42 сек');
    expect(listenLabel(null)).toBe('Прослушать');
  });
  it('версия фактов не меняется от того, что до встречи стало на минуту меньше', () => {
    const a = base({ firstMeeting: { id: '1', title: 'Acme', time: '14:00', minutesLeft: 300 } });
    const b = base({ firstMeeting: { id: '1', title: 'Acme', time: '14:00', minutesLeft: 299 } });
    expect(factsHash(a, 'normal')).toBe(factsHash(b, 'normal'));
    expect(factsHash(a, 'normal')).not.toBe(factsHash(a, 'short'));
  });
});
