import {
  ChatMsg, cleanDecisionText, decisionDone, isDecisionText, isQuestionText, meetingQuestions,
  parseAiCandidates, pollOptions, unansweredQuestions,
} from './chat-decisions.rules';

describe('chat-decisions.rules', () => {
  it('решение узнаётся по словам, в том числе в начале и с пунктуацией', () => {
    expect(isDecisionText('Решили: чат переименовать в «РАЗРАБОТКА QEVO»')).toBe(true);
    expect(isDecisionText('ок, договорились, запускаем в понедельник')).toBe(true);
    expect(isDecisionText('Итого — макет до пятницы')).toBe(true);
    expect(isDecisionText('Утвердили бюджет на ноябрь')).toBe(true);
    expect(isDecisionText('Согласовали с клиентом цвета')).toBe(true);
  });

  it('не решение: вопрос, отрицание, слово внутри другого, коротко', () => {
    expect(isDecisionText('Мы решили, кто делает видео?')).toBe(false);
    expect(isDecisionText('Пока не договорились о сроках')).toBe(false);
    expect(isDecisionText('нерешили')).toBe(false);
    expect(isDecisionText('Перерешили всё заново и пошли гулять')).toBe(false);
    expect(isDecisionText('итого')).toBe(false);
  });

  it('текст решения — без «Решили:» и с заглавной', () => {
    expect(cleanDecisionText('решили: чат переименовать в «РАЗРАБОТКА QEVO»')).toBe('Чат переименовать в «РАЗРАБОТКА QEVO»');
    expect(cleanDecisionText('Договорились, что релиз в пятницу')).toBe('Релиз в пятницу');
    expect(cleanDecisionText('x'.repeat(400)).length).toBe(298);
  });

  it('вопрос: «?» вне ссылок', () => {
    expect(isQuestionText('Кто делает видео для лендинга?')).toBe(true);
    expect(isQuestionText('Смотри https://x.ru/a?b=1 макет')).toBe(false);
    expect(isQuestionText('ок?')).toBe(false);
  });

  it('вопросы без ответа: ветка, цитата и продолжение разговора закрывают вопрос', () => {
    const now = new Date('2026-11-13T12:00:00Z');
    const at = (h: number, m = 0) => new Date(now.getTime() - h * 3_600_000 + m * 60_000);
    const msg = (id: string, authorId: string, body: string, t: Date, extra: Partial<ChatMsg> = {}): ChatMsg =>
      ({ id, authorId, body, at: t, threadRootId: null, replyCount: 0, replyToId: null, ...extra });
    const list: ChatMsg[] = [
      msg('1', 'a', 'Кто делает видео для лендинга?', at(30)),
      msg('2', 'a', 'Где лежит макет договора?', at(20)),
      msg('3', 'b', 'Вот он', at(20, 10)),
      msg('4', 'a', 'Когда релиз мобильной версии?', at(10), { replyCount: 2 }),
      msg('5', 'a', 'Кто проверит счёт от подрядчика?', at(8)),
      msg('6', 'b', 'я проверю', at(7), { replyToId: '5' }),
      msg('7', 'a', 'Нужен ли нам новый логотип?', at(1)),
      msg('8', 'a', 'Есть доступ к серверу у Глеба?', at(5)),
      msg('9', 'b', 'Надо подумать', at(3)),
    ];
    expect(unansweredQuestions(list, now).map((m) => m.id)).toEqual(['1', '8']);
  });

  it('выполнено — по закрытой задаче или вручную', () => {
    expect(decisionDone({ done_at: null, task_closed_at: new Date() })).toEqual({ done: true, by: 'task' });
    expect(decisionDone({ done_at: new Date(), task_closed_at: null })).toEqual({ done: true, by: 'manual' });
    expect(decisionDone({ done_at: null, task_closed_at: null })).toEqual({ done: false, by: null });
  });

  it('вопросы протокола: строки и { text }', () => {
    expect(meetingQuestions(['Кто платит за домен?', { text: 'Нужен ли iOS', sec: 12 }, '', 5])).toEqual(['Кто платит за домен?', 'Нужен ли iOS']);
    expect(meetingQuestions(null)).toEqual([]);
  });

  it('ответ модели: только настоящие id, без повторов', () => {
    const raw = 'Вот: {"decisions":[{"id":"10","text":"Релиз в пятницу"},{"id":"99","text":"выдумка"},{"id":"10","text":"повтор"},{"id":"11","text":""}]}';
    expect(parseAiCandidates(raw, new Set(['10', '11']))).toEqual([{ id: '10', text: 'Релиз в пятницу' }]);
    expect(parseAiCandidates('не json', new Set(['1']))).toEqual([]);
  });

  it('варианты опроса: чистка и «Да / Нет» по умолчанию', () => {
    expect(pollOptions([' Да ', 'да', 'Нет', ''])).toEqual(['Да', 'Нет']);
    expect(pollOptions(['Только один'])).toEqual(['Да', 'Нет']);
    expect(pollOptions(['A', 'B', 'C'])).toEqual(['A', 'B', 'C']);
  });
});
