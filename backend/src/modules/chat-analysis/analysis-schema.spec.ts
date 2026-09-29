import { dedupKeyOf, MAX_ACTIONS, parseAnalysis, RefCatalog } from './analysis-schema';

const now = new Date('2026-09-29T09:00:00.000Z');

const cat = (): RefCatalog => ({
  users: new Map([['u1', '7'], ['u2', '18']]),
  projects: new Map([['p1', '130']]),
  messageIds: new Set(['881', '882', '886']),
});

const answer = (actions: unknown[]) => JSON.stringify({ actions });

const task = (over: Record<string, unknown> = {}) => ({
  type: 'task',
  title: 'Исправить API авторизации',
  description: 'по итогам обсуждения',
  project_ref: 'p1',
  assigner_ref: 'u1',
  assignee_ref: 'u2',
  deadline: '2026-10-02T15:00:00.000Z',
  confidence: { intent: 0.97, project: 0.93, assigner: 0.99, assignee: 0.91 },
  sources: [{ message_id: '881', role: 'instruction' }, { message_id: '886', role: 'acceptance' }],
  ...over,
});

describe('ответ модели о переписке', () => {
  it('разбирает наблюдение и переводит пометки в наши номера', () => {
    const [a] = parseAnalysis(answer([task()]), cat(), now);
    expect(a).toMatchObject({
      type: 'task', title: 'Исправить API авторизации',
      projectId: '130', assignerId: '7', assigneeId: '18',
    });
    expect(a.confidence).toEqual({ intent: 0.97, project: 0.93, assigner: 0.99, assignee: 0.91 });
    expect(a.sources).toEqual([
      { messageId: '881', role: 'instruction' }, { messageId: '886', role: 'acceptance' },
    ]);
  });

  it('придуманных людей и проекты не берём: это чужая задача, а не догадка', () => {
    const [a] = parseAnalysis(answer([task({ assignee_ref: 'u99', project_ref: 'p42' })]), cat(), now);
    expect(a.assigneeId).toBeNull();
    expect(a.projectId).toBeNull();
    // Само наблюдение остаётся: «задача есть, кому — неизвестно» это рабочий случай.
    expect(a.type).toBe('task');
  });

  it('наблюдение без сообщений-источников выбрасываем целиком', () => {
    // Проверить его человеку нечем, а выглядеть оно будет так же уверенно.
    expect(parseAnalysis(answer([task({ sources: [] })]), cat(), now)).toEqual([]);
    expect(parseAnalysis(answer([task({ sources: [{ message_id: '999' }] })]), cat(), now)).toEqual([]);
  });

  it('ссылки на чужие сообщения отсекаются, свои остаются', () => {
    const [a] = parseAnalysis(answer([task({
      sources: [{ message_id: '881' }, { message_id: '12345' }, { message_id: '881' }],
    })]), cat(), now);
    expect(a.sources).toEqual([{ messageId: '881', role: 'context' }]);
  });

  it('неизвестный вид наблюдения не принимаем', () => {
    expect(parseAnalysis(answer([task({ type: 'invoice' })]), cat(), now)).toEqual([]);
    expect(parseAnalysis(answer([task({ type: '' })]), cat(), now)).toEqual([]);
  });

  it('наблюдение без названия не принимаем', () => {
    expect(parseAnalysis(answer([task({ title: '   ' })]), cat(), now)).toEqual([]);
  });

  it('неизвестная роль сообщения становится обычным контекстом', () => {
    const [a] = parseAnalysis(answer([task({ sources: [{ message_id: '882', role: 'шутка' }] })]), cat(), now);
    expect(a.sources).toEqual([{ messageId: '882', role: 'context' }]);
  });

  it('срок и время встречи в прошлом не берём', () => {
    const [a] = parseAnalysis(answer([task({
      deadline: '2026-09-01T10:00:00.000Z', meeting_at: 'вчера',
    })]), cat(), now);
    expect(a.deadlineAt).toBeNull();
    expect(a.meetingAt).toBeNull();
  });

  it('уверенность вне отрезка и мусором считается нулевой', () => {
    const [a] = parseAnalysis(answer([task({
      confidence: { intent: 5, project: -1, assigner: 'высокая', assignee: null },
    })]), cat(), now);
    expect(a.confidence).toEqual({ intent: 1, project: 0, assigner: 0, assignee: 0 });
  });

  it('ответ в обёртке ```json разбирается', () => {
    const raw = '```json\n' + answer([task()]) + '\n```';
    expect(parseAnalysis(raw, cat(), now)).toHaveLength(1);
  });

  it('сломанный ответ не роняет проход, а даёт пустой список', () => {
    expect(parseAnalysis('модель сегодня не в духе', cat(), now)).toEqual([]);
    expect(parseAnalysis('', cat(), now)).toEqual([]);
    expect(parseAnalysis(JSON.stringify({ actions: 'нет' }), cat(), now)).toEqual([]);
  });

  it('разросшийся ответ обрезаем: это сбой разбора, а не сто поручений', () => {
    const many = Array.from({ length: MAX_ACTIONS + 15 }, (_, i) => task({ title: `Задача ${i}` }));
    expect(parseAnalysis(answer(many), cat(), now)).toHaveLength(MAX_ACTIONS);
  });
});

describe('ключ от повторной обработки', () => {
  const base = {
    type: 'task', title: 'Исправить API авторизации',
    projectId: '130', assigneeId: '18', sources: [{ messageId: '881' }, { messageId: '886' }],
  };

  it('один смысл — один ключ, как бы ни был записан заголовок', () => {
    expect(dedupKeyOf({ ...base, title: '  ИСПРАВИТЬ  API   авторизации! ' })).toBe(dedupKeyOf(base));
  });

  it('порядок сообщений-источников на ключ не влияет', () => {
    expect(dedupKeyOf({ ...base, sources: [{ messageId: '886' }, { messageId: '881' }] }))
      .toBe(dedupKeyOf(base));
  });

  it('другой исполнитель или другой проект — другое наблюдение', () => {
    expect(dedupKeyOf({ ...base, assigneeId: '7' })).not.toBe(dedupKeyOf(base));
    expect(dedupKeyOf({ ...base, projectId: '131' })).not.toBe(dedupKeyOf(base));
  });

  it('тот же текст в другом разговоре — другое наблюдение', () => {
    expect(dedupKeyOf({ ...base, sources: [{ messageId: '901' }] })).not.toBe(dedupKeyOf(base));
  });
});
