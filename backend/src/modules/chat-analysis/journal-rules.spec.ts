import { autoLogDecision, noteReadiness, noteText, participantsOf, resolveTask, taskNumbersIn } from './journal-rules';

const src = (o: Partial<{ messageId: string; authorId: string | null; sharedTaskId: string | null; text: string }>) => ({
  messageId: '1', authorId: '10', sharedTaskId: null, text: '', ...o,
});

describe('taskNumbersIn', () => {
  it('находит номера после решётки, в том числе рядом с кириллицей', () => {
    expect(taskNumbersIn('по #1344 готово, а #12уже нет')).toEqual(['1344', '12']);
    expect(taskNumbersIn('# 7 стоит')).toEqual(['7']);
  });
  it('без решётки число — не номер задачи', () => {
    expect(taskNumbersIn('осталось 3 дня')).toEqual([]);
  });
});

describe('resolveTask', () => {
  const owners = new Map([['55', { assigneeId: '10', creatorId: '20' }]]);

  it('пересланная карточка задачи — уверенность 1', () => {
    const r = resolveTask({ sources: [src({ sharedTaskId: '77' })], alive: new Set(['77']), modelTaskId: null, owners });
    expect(r).toEqual({ taskId: '77', confidence: 1, ground: 'shared' });
  });

  it('названный номер — уверенность 1', () => {
    const r = resolveTask({ sources: [src({ text: 'по #77 жду доступ' })], alive: new Set(['77']), modelTaskId: '55', owners });
    expect(r).toEqual({ taskId: '77', confidence: 1, ground: 'spoken' });
  });

  it('номер несуществующей или удалённой задачи не считается', () => {
    const r = resolveTask({ sources: [src({ text: 'по #99 жду' })], alive: new Set(), modelTaskId: null, owners });
    expect(r.taskId).toBeNull();
  });

  it('названо две задачи — не выбираем, даже если модель выбрала', () => {
    const r = resolveTask({
      sources: [src({ text: '#77 готова, #78 стоит' })], alive: new Set(['77', '78']), modelTaskId: '77',
      owners: new Map([['77', { assigneeId: '10', creatorId: null }]]),
    });
    expect(r.taskId).toBeNull();
  });

  it('выбор модели принимаем, когда автор сообщения — исполнитель задачи', () => {
    const r = resolveTask({ sources: [src({ authorId: '10' })], alive: new Set(), modelTaskId: '55', owners });
    expect(r).toEqual({ taskId: '55', confidence: 0.8, ground: 'author' });
  });

  it('и когда автор — постановщик', () => {
    const r = resolveTask({ sources: [src({ authorId: '20' })], alive: new Set(), modelTaskId: '55', owners });
    expect(r.ground).toBe('author');
  });

  it('о чужой задаче по догадке модели не пишем', () => {
    const r = resolveTask({ sources: [src({ authorId: '30' })], alive: new Set(), modelTaskId: '55', owners });
    expect(r).toEqual({ taskId: null, confidence: 0, ground: 'none' });
  });

  it('задачу не из справочника не принимаем', () => {
    const r = resolveTask({ sources: [src({ authorId: '10' })], alive: new Set(), modelTaskId: '999', owners });
    expect(r.taskId).toBeNull();
  });
});

describe('noteReadiness', () => {
  it('решение готово при высокой уверенности', () => {
    expect(noteReadiness({ type: 'decision', intent: 0.95, taskId: null, cancelled: false })).toBe('ready');
    expect(noteReadiness({ type: 'decision', intent: 0.7, taskId: null, cancelled: false })).toBe('detected');
  });
  it('статусу и блокеру без задачи класть некуда', () => {
    expect(noteReadiness({ type: 'blocker', intent: 0.99, taskId: null, cancelled: false })).toBe('detected');
    expect(noteReadiness({ type: 'blocker', intent: 0.99, taskId: '5', cancelled: false })).toBe('ready');
  });
  it('отменённое в разговоре не готово', () => {
    expect(noteReadiness({ type: 'decision', intent: 0.99, taskId: null, cancelled: true })).toBe('detected');
  });
  it('идея и вопрос не готовы никогда', () => {
    expect(noteReadiness({ type: 'idea', intent: 1, taskId: '5', cancelled: false })).toBe('detected');
  });
});

describe('autoLogDecision', () => {
  it('только решение, только готовое и только в режиме владельца', () => {
    expect(autoLogDecision({ mode: 'auto_high', type: 'decision', status: 'ready' })).toBe(true);
    expect(autoLogDecision({ mode: 'suggest', type: 'decision', status: 'ready' })).toBe(false);
    expect(autoLogDecision({ mode: 'auto_high', type: 'decision', status: 'detected' })).toBe(false);
    // статус и блокер — строка в чужой задаче: сам не пишет даже в этом режиме
    expect(autoLogDecision({ mode: 'auto_high', type: 'blocker', status: 'ready' })).toBe(false);
  });
});

describe('participantsOf / noteText', () => {
  it('участники — авторы без повторов и без бота', () => {
    expect(participantsOf([{ authorId: '1' }, { authorId: null }, { authorId: '1' }, { authorId: '2' }])).toEqual(['1', '2']);
  });
  it('строка в задаче говорит, чьи это слова и откуда', () => {
    const t = noteText({ type: 'blocker', title: 'ждём доступ от клиента', author: 'Юрий', chat: 'Панорама', quote: 'не могу закончить' });
    expect(t).toContain('Помеха в работе: ждём доступ от клиента.');
    expect(t).toContain('в чате «Панорама», пишет Юрий');
    expect(t).toContain('«не могу закончить»');
  });
});
