import { meetingPlans, parseModelJson, validateMeetingAnalysis } from './meeting-schema';

describe('Встречи: валидация разбора LLM', () => {
  const ok = {
    summary: 'Обсудили сроки интеграции и распределили работы.',
    decisions: ['Интеграцию делаем через вебхуки'],
    risks: ['Ключ YouGile может протухнуть'],
    tasks: [{ title: 'Сделать интеграцию', description: 'по вебхукам', assignee: 'Алина', deadline: '2026-09-01', quote: 'Алина: беру интеграцию' }],
  };

  it('нормальный ответ проходит целиком', () => {
    const { value, errors } = validateMeetingAnalysis(ok);
    expect(errors).toEqual([]);
    expect(value!.tasks[0]).toMatchObject({ title: 'Сделать интеграцию', assigneeHint: 'Алина', quote: 'Алина: беру интеграцию' });
    expect(value!.tasks[0].deadline).toMatch(/^2026-09-01T/);
  });

  it('без сводки результат непригоден', () => {
    expect(validateMeetingAnalysis({ ...ok, summary: '   ' }).value).toBeNull();
    expect(validateMeetingAnalysis('строка').value).toBeNull();
    expect(validateMeetingAnalysis(null).value).toBeNull();
  });

  it('битую задачу отбрасываем, остальные сохраняем', () => {
    const { value, errors } = validateMeetingAnalysis({
      ...ok,
      tasks: [{ title: '' }, 'мусор', { title: 'Живая задача' }],
    });
    expect(value!.tasks.map((t) => t.title)).toEqual(['Живая задача']);
    expect(errors).toHaveLength(2); // пустой заголовок + не объект
  });

  it('невалидный срок становится null, а не «сегодня»', () => {
    const { value } = validateMeetingAnalysis({ ...ok, tasks: [{ title: 'X', deadline: 'как-нибудь потом' }] });
    expect(value!.tasks[0].deadline).toBeNull();
  });

  it('поток задач ограничен сверху', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ title: `Задача ${i}` }));
    const { value, errors } = validateMeetingAnalysis({ ...ok, tasks: many });
    expect(value!.tasks).toHaveLength(20);
    expect(errors.some((e) => /больше 20/.test(e))).toBe(true);
  });

  it('решения и риски — только строки, длина ограничена', () => {
    const { value } = validateMeetingAnalysis({ ...ok, decisions: ['ок', 42, null, 'x'.repeat(900)], risks: 'не массив' });
    expect(value!.decisions).toHaveLength(2); // число и null выброшены, остались две строки
    expect(value!.decisions[1].text).toHaveLength(500);
    expect(value!.risks).toEqual([]);
  });
});

describe('#4749: договорённости о следующей встрече', () => {
  it('день обязателен, время — только ЧЧ:ММ, участники — строки', () => {
    expect(meetingPlans([
      { title: 'Созвон по сайту', date: '2026-11-06', time: '9:30', participants: ['Глеб Ковалёв', 7, ''], at: '12:03', quote: 'созвонимся в пятницу в полдесятого' },
      { title: 'Без дня', date: null, time: '10:00' },
      { title: 'Кривой день', date: '06.11.2026', time: '10:00' },
      { title: 'Время словами', date: '2026-11-07', time: 'утром' },
      { title: '', date: '2026-11-07', time: '10:00' },
    ])).toEqual([
      { title: 'Созвон по сайту', date: '2026-11-06', time: '09:30', participants: ['Глеб Ковалёв'], durationMinutes: null, quote: 'созвонимся в пятницу в полдесятого', sec: 723 },
      { title: 'Время словами', date: '2026-11-07', time: null, participants: [], durationMinutes: null, quote: null, sec: null },
    ]);
    expect(meetingPlans([{ title: 'X', date: '2026-11-07', time: '25:00' }])[0].time).toBeNull();
    expect(meetingPlans('мусор')).toEqual([]);
  });

  it('разбор без поля meetings — пустой список, а не ошибка', () => {
    const { value } = validateMeetingAnalysis({ summary: 'итоги', tasks: [] });
    expect(value!.meetings).toEqual([]);
  });
});

describe('26.11: ответ модели оборван потолком длины', () => {
  const head = '```json\n{"summary":"Итоги: {скобки} и, запятые в тексте","decisions":[{"text":"Ставить ссылки на новый домен","at":"12:01"}],'
    + '"tasks":[{"title":"Создать сообщество в Instagram","assignee":"Глеб","quote":"создай, пожалуйста"},'
    + '{"title":"Закинуть список задач в Slack","assignee":"Виктор","author":"Павел","at":"28:22",';
  it('целые задачи остаются, недописанная отбрасывается', () => {
    const parsed = parseModelJson(head) as { tasks: { title: string }[] };
    const { value, errors } = validateMeetingAnalysis(parsed);
    expect(value!.summary).toContain('{скобки}');
    expect(value!.tasks.map((t) => t.title)).toEqual(['Создать сообщество в Instagram']);
    expect(value!.decisions).toHaveLength(1);
    expect(errors).toEqual([]);
  });
  it('оборвано внутри строки — тоже чинится', () => {
    const parsed = parseModelJson(head + '"quote":"закинь, пожа') as { tasks: unknown[] };
    expect(parsed.tasks).toHaveLength(1);
  });
  it('целый ответ с пояснениями вокруг — как раньше; мусор — null', () => {
    expect(parseModelJson('Вот разбор:\n```json\n{"summary":"x","tasks":[]}\n```\nГотово')).toEqual({ summary: 'x', tasks: [] });
    expect(parseModelJson('не знаю')).toBeNull();
    expect(parseModelJson('{"summary":')).toBeNull();
  });
});
