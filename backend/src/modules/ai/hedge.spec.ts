import { deadlineSignal, hedge, HedgeRun, rejectAfter } from './hedge';
import { RealAiProvider } from './ai.provider';

/*
  #4666: быстрый ответ модели. Первая непустая побеждает, задумавшуюся догоняет
  следующая через hedgeMs, отказ — сразу следующая; потолок вызывающего — «timeout».
*/
const later = (ms: number, text: string, log?: string[], name?: string): HedgeRun['run'] => (signal) =>
  new Promise((resolve, reject) => {
    log?.push(`start:${name}`);
    const t = setTimeout(() => resolve(text), ms);
    signal.addEventListener('abort', () => { clearTimeout(t); log?.push(`abort:${name}`); reject(new Error('aborted')); });
  });

describe('hedge — быстрые модели внахлёст', () => {
  it('первая успела до нахлёста — вторую даже не спрашиваем', async () => {
    const log: string[] = [];
    const r = await hedge([
      { name: 'a', usedModel: 'A', run: later(10, 'ответ A', log, 'a') },
      { name: 'b', usedModel: 'B', run: later(10, 'ответ B', log, 'b') },
    ], 200);
    expect(r).toMatchObject({ text: 'ответ A', usedModel: 'A' });
    expect(log).toEqual(['start:a']);
  });

  it('первая задумалась — вторая стартует через hedgeMs и побеждает, первая отменяется', async () => {
    const log: string[] = [];
    const r = await hedge([
      { name: 'a', usedModel: 'A', run: later(1000, 'ответ A', log, 'a') },
      { name: 'b', usedModel: 'B', run: later(10, 'ответ B', log, 'b') },
    ], 30);
    expect(r.usedModel).toBe('B');
    expect(log).toEqual(['start:a', 'start:b', 'abort:a']);
  });

  it('отказ или пустой ответ — следующая сразу, не дожидаясь нахлёста', async () => {
    const t0 = Date.now();
    const r = await hedge([
      { name: 'a', usedModel: 'A', run: async () => { throw new Error('429'); } },
      { name: 'b', usedModel: 'B', run: async () => '  ' },
      { name: 'c', usedModel: 'C', run: later(5, 'ответ C') },
    ], 5000);
    expect(r.usedModel).toBe('C');
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('все отказали — ошибка со всеми причинами', async () => {
    await expect(hedge([
      { name: 'a', usedModel: 'A', run: async () => { throw new Error('нет ключа'); } },
      { name: 'b', usedModel: 'B', run: async () => '' },
    ], 10)).rejects.toThrow(/нет ключа.*пустой/);
  });

  it('потолок вызывающего вышел — «timeout», запросы отменены', async () => {
    const log: string[] = [];
    const dl = deadlineSignal(40);
    await expect(hedge([
      { name: 'a', usedModel: 'A', run: later(5000, 'A', log, 'a') },
      { name: 'b', usedModel: 'B', run: later(5000, 'B', log, 'b') },
    ], 10, dl.signal)).rejects.toThrow('timeout');
    expect(log).toEqual(expect.arrayContaining(['abort:a', 'abort:b']));
    dl.cancel();
  });

  it('rejectAfter: успело — значение, не успело — timeout', async () => {
    const ok = deadlineSignal(200);
    await expect(rejectAfter(new Promise((r) => setTimeout(() => r('да'), 5)), ok.signal)).resolves.toBe('да');
    ok.cancel();
    const slow = deadlineSignal(20);
    await expect(rejectAfter(new Promise((r) => setTimeout(() => r('поздно'), 500)), slow.signal)).rejects.toThrow('timeout');
    slow.cancel();
  });
});

describe('RealAiProvider.generate({ fast }) — #4666', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('Kimi основной: сначала Kimi без рассуждения (K2.6), задумался — отвечает gpt-4o-mini', async () => {
    const calls: { url: string; body: any }[] = [];
    global.fetch = jest.fn((url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      const slow = String(url).includes('moonshot');
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve(new Response(JSON.stringify({ choices: [{ message: { content: slow ? 'kimi' : 'gpt' } }] }), { status: 200 })), slow ? 2000 : 5);
        init.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
      });
    }) as any;
    process.env.AI_FAST_HEDGE_MS = '20';
    const p = new RealAiProvider('sk-openai', undefined, 'x', 'kimi-k3', undefined, 'sk-kimi');
    expect(await p.generate('с', 'в', { fast: true, maxTokens: 300 })).toBe('gpt');
    delete process.env.AI_FAST_HEDGE_MS;
    expect(calls[0].url).toContain('moonshot');
    expect(calls[0].body).toMatchObject({ model: 'kimi-k2.6', thinking: { type: 'disabled' }, max_completion_tokens: 300 });
    expect(calls[1].body).toMatchObject({ model: 'gpt-4o-mini', max_tokens: 300 });
    expect(p.lastModel).toBe('gpt-4o-mini');
  });

  it('потолок вышел — отказ «timeout», а не заглушка: дальше работают правила', async () => {
    global.fetch = jest.fn((_url: any, init: any) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as any;
    const p = new RealAiProvider('sk-openai', undefined, 'x', 'kimi-k3', undefined, 'sk-kimi');
    const dl = deadlineSignal(30);
    await expect(p.generate('с', 'в', { fast: true, signal: dl.signal })).rejects.toThrow('timeout');
    dl.cancel();
  });
});
