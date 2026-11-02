import { fastTitleFrom, isShortCommand, NlTiming, wordCount, sliceByAnchors } from './fast-path';
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

  // #4712: обычная надиктовка — средний путь
  const SAID = 'Сергей, по сайту: поправить кнопку входа, после ввода пароля не пускает. Глебу обновить шапку на телефоне.';
  const byKind = (split: unknown, task: (user: string) => unknown) => jest.fn(async (_t: string, system: string, user: string) => (
    system.startsWith('Ты делишь надиктовку') ? JSON.stringify(split) : JSON.stringify(task(user))
  ));

  it('средний путь, одно поручение — разбор и деление одновременно, оба быстрые', async () => {
    const generate = byKind({ tasks: [{ start: 'Сергей по сайту поправить', department: 'dev', specialization: null, confidence: 0.4 }] },
      () => ({ intent: 'create_task', confidence: 0.9, task: { title: 'Поправить кнопку входа' } }));
    const { svc } = make(generate);
    const timing: NlTiming = {};
    const drafts = await svc.parseMany('t', 'u', SAID, null, { auto: true, mid: true, timing });
    expect(generate).toHaveBeenCalledTimes(2);
    for (const c of generate.mock.calls as any[]) expect(c[4]).toMatchObject({ fast: true, timeoutMs: expect.any(Number) });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].task).toMatchObject({ title: 'Поправить кнопку входа', auto: true });
    expect(timing).toMatchObject({ path: 'mid', splitItems: 1, drafts: 1 });
  });

  it('средний путь, два поручения — куски по началам, каждый оформлен отдельно', async () => {
    const generate = byKind(
      { tasks: [{ start: 'поправить кнопку входа после' }, { start: 'Глебу обновить шапку на' }] },
      (user) => ({ intent: 'create_task', confidence: 0.9, task: { title: JSON.parse(user).text.includes('шапку') && !JSON.parse(user).text.includes('кнопку') ? 'Обновить шапку' : 'Поправить вход' } }),
    );
    const { svc } = make(generate);
    const drafts = await svc.parseMany('t', 'u', SAID, null, { mid: true });
    // одиночный разбор + деление + два куска
    expect(generate).toHaveBeenCalledTimes(4);
    expect(drafts.map((d) => d.task!.title)).toEqual(['Поправить вход', 'Обновить шапку']);
  });

  it('средний путь: быстрая модель не успела — тот же разбор полным путём', async () => {
    const generate = jest.fn(async (_t: string, system: string, _user: string, _k: string, o: any) => {
      if (system.startsWith('Ты делишь надиктовку')) throw new Error('timeout');
      if (o?.fast) throw new Error('timeout');
      return JSON.stringify({ intent: 'create_task', confidence: 0.9, task: { title: 'Поправить кнопку входа' } });
    });
    const { svc } = make(generate);
    const timing: NlTiming = {};
    const drafts = await svc.parseMany('t', 'u', 'Сергей, по сайту: поправить кнопку входа, после ввода пароля не пускает', null, { mid: true, timing });
    expect(drafts[0].task!.title).toBe('Поправить кнопку входа');
    expect(timing.midFallback).toBe(true);
    expect((generate.mock.calls as any[]).some((c) => !c[4]?.fast)).toBe(true);
  });
});

describe('sliceByAnchors (#4712)', () => {
  const text = 'Сергею в проект QEVO на завтра. Первая задача — протестировать вход на сайте, там падает форма. '
    + 'Вторая: Глебу поправить шапку на телефоне. И ещё Алине проверить тексты лендинга до пятницы.';

  it('режет речь по началам поручений, общая часть не входит в куски', () => {
    const parts = sliceByAnchors(text, ['Первая задача протестировать вход', 'Вторая Глебу поправить шапку', 'Алине проверить тексты лендинга']);
    expect(parts.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(parts[0].part.startsWith('Первая задача')).toBe(true);
    expect(parts[0].part).toContain('падает форма');
    expect(parts[1].part).toMatch(/^Вторая: Глебу поправить шапку на телефоне\. И ещё$/);
    expect(parts[2].part).toBe('Алине проверить тексты лендинга до пятницы.');
  });

  it('регистр и ё не мешают, ненайденное начало пропускается', () => {
    const parts = sliceByAnchors(text, ['первая задача протестировать', 'Мише переделать всё', 'алине проверить']);
    expect(parts.map((p) => p.index)).toEqual([0, 2]);
  });

  it('нашлось меньше двух начал — резать нечего', () => {
    expect(sliceByAnchors(text, ['Первая задача', 'Совсем другое начало'])).toEqual([]);
    expect(sliceByAnchors(text, [])).toEqual([]);
  });

  it('не возвращается назад: одинаковые начала берутся по порядку', () => {
    const t = 'Проверить форму на сайте. Проверить форму в приложении.';
    const parts = sliceByAnchors(t, ['Проверить форму на', 'Проверить форму в']);
    expect(parts.map((p) => p.part)).toEqual(['Проверить форму на сайте.', 'Проверить форму в приложении.']);
  });
});
