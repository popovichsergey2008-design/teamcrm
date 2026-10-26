import { fastTitleFrom, isShortCommand, NlTiming, wordCount } from './fast-path';
import { NlService } from './nl.service';

describe('#4666 быстрый путь короткой фразы', () => {
  it('короткая фраза в несколько слов — быстрый путь', () => {
    expect(isShortCommand('Сергею поправить кнопку входа')).toBe(true);
    expect(isShortCommand('Задача на Сергея, проект QEVO, дедлайн на завтра, поправить вход')).toBe(true);
  });

  it('длинная надиктовка и пачка поручений — полный путь', () => {
    const long = 'Задача на Сергея. Проект QEVO, дедлайн на сегодня. В мобильном приложении при постановке задачи голосом очень долго идёт обработка, нужно ускорить';
    expect(isShortCommand(long)).toBe(false);
    expect(isShortCommand('1. Поправить вход\n2. Обновить тексты')).toBe(false);
    expect(isShortCommand('ок')).toBe(false);
  });

  it('слова считаются и кириллицей', () => {
    expect(wordCount('Глебу — форма входа, к пятнице!')).toBe(5);
  });

  it('заголовок без модели: без имени исполнителя и срока', () => {
    const people = ['Сергей Попович', 'Глеб Иванов'];
    expect(fastTitleFrom('Сергею поправить кнопку входа к пятнице.', people)).toBe('Поправить кнопку входа');
    expect(fastTitleFrom('для Глеба обновить тексты на сайте завтра', people)).toBe('Обновить тексты на сайте');
    // не сотрудник — глагол не трогаем
    expect(fastTitleFrom('Проверьте форму оплаты срочно', people)).toBe('Проверьте форму оплаты');
    expect(fastTitleFrom('завтра', people)).toBe('Завтра');
  });
});

/*
  Разбор короткой фразы целиком: ОДИН вызов модели (без счёта задач), быстрая модель
  с потолком; модель не успела — черновик правилами, а не ошибка и не ожидание.
*/
describe('#4666 parseMany: короткая фраза', () => {
  const users = [{ id: '1', name: 'Сергей Попович' }, { id: '2', name: 'Глеб Иванов' }];
  const make = (generate: jest.Mock) => {
    const db = {
      many: jest.fn(async (sql: string) => (/FROM users/.test(sql) ? users : [])),
      one: jest.fn(async (sql: string) => (/roles/.test(sql) ? { role: 'owner' } : null)),
    };
    const org = {
      snapshot: jest.fn(async () => ({ people: [], departments: [] })),
      seers: jest.fn(async () => new Map()),
      decide: jest.fn(() => ({ userId: '1', name: 'Сергей Попович', source: 'named', reason: 'назван', directions: [], skill: null, warnings: [], noLeadFor: null })),
    };
    const resolver = {
      candidates: jest.fn(async () => [{ id: '10', name: 'QEVO' }]),
      resolve: jest.fn(async () => ({ level: 'HIGH', projectId: '10', projectName: 'QEVO', confidence: 0.9, hint: 'назван', resolution: 'named', reasonCodes: [], alternatives: [], notFoundName: null })),
    };
    const tags = { suggest: jest.fn(async () => ({ suggestions: [{ tagId: '5', name: 'Баг', color: null }] })) };
    const prompts = { resolve: jest.fn(async () => null) };
    const ai = { generate };
    const svc = new (NlService as any)(db, ai, prompts, {}, {}, tags, {}, {}, {}, {}, resolver, {}, org) as NlService;
    return { svc, tags };
  };

  it('модель ответила — один быстрый вызов, без счёта задач', async () => {
    const generate = jest.fn(async () => JSON.stringify({ intent: 'create_task', confidence: 0.9, task: { title: 'Поправить кнопку входа', checklist: ['Кнопка работает'] } }));
    const { svc, tags } = make(generate);
    const timing: NlTiming = {};
    const drafts = await svc.parseMany('t', 'u', 'Сергею поправить кнопку входа', null, { auto: true, fast: true, timing });
    expect(generate).toHaveBeenCalledTimes(1);
    expect((generate.mock.calls[0] as any[])[4]).toMatchObject({ fast: true, timeoutMs: expect.any(Number), maxTokens: expect.any(Number) });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].task).toMatchObject({ title: 'Поправить кнопку входа', projectId: '10', assigneeId: '1', auto: true });
    // теги — одним вызовом, параллельно разбору, тоже быстрым
    expect(tags.suggest).toHaveBeenCalledTimes(1);
    expect((tags.suggest.mock.calls[0] as any[])[2]).toMatchObject({ fast: true });
    expect(drafts[0].task!.autoTags).toEqual([{ id: '5', name: 'Баг', color: null }]);
    expect(timing).toMatchObject({ path: 'fast', model: 'ok', drafts: 1 });
  });

  it('модель не успела (timeout) — черновик правилами, без имени и срока в названии', async () => {
    const generate = jest.fn(async () => { throw new Error('timeout'); });
    const { svc } = make(generate);
    const timing: NlTiming = {};
    const drafts = await svc.parseMany('t', 'u', 'Сергею поправить кнопку входа завтра', null, { auto: true, fast: true, timing });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].intent).toBe('create_task');
    expect(drafts[0].task!.title).toBe('Поправить кнопку входа');
    expect(drafts[0].task!.deadline).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(timing).toMatchObject({ path: 'fast', model: 'timeout' });
  });

  it('полный путь (не короткая фраза) — по-прежнему счёт задач и разбор', async () => {
    const generate = jest.fn(async () => '{}');
    const { svc } = make(generate);
    await svc.parseMany('t', 'u', 'Сергею поправить кнопку входа', null, {});
    expect(generate).toHaveBeenCalledTimes(2);
    expect((generate.mock.calls[0] as any[])[4]?.fast).toBeUndefined();
  });
});
