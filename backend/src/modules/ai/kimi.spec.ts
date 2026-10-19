import { RealAiProvider } from './ai.provider';
import { estimateCost } from './usage-catalog';

/*
  Kimi (19.10): с ключом Kimi и выбранной моделью Kimi вся текстовая работа идёт в Kimi —
  даже если навык просит чужую модель; рассуждение K3 — «low», с запасом токенов.
*/
describe('Kimi как основной ИИ', () => {
  const realFetch = global.fetch;
  let calls: { url: string; body: any }[];
  beforeEach(() => {
    calls = [];
    global.fetch = jest.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ответ', reasoning_content: 'думаю' } }] }), { status: 200 });
    }) as any;
  });
  afterAll(() => { global.fetch = realFetch; });

  it('модель Kimi у компании — запрос с моделью gpt-4o-mini всё равно идёт в Kimi', async () => {
    const p = new RealAiProvider('sk-openai', undefined, 'claude-haiku-4-5', 'kimi-k3', undefined, 'sk-kimi');
    const text = await p.generate('система', 'вопрос', { model: 'gpt-4o-mini', maxTokens: 500 });
    expect(text).toBe('ответ');
    expect(calls[0].url).toBe('https://api.moonshot.ai/v1/chat/completions');
    expect(calls[0].body).toMatchObject({ model: 'kimi-k3', reasoning_effort: 'low', max_completion_tokens: 8500 });
    expect(calls[0].body.max_tokens).toBeUndefined();
    expect(p.lastModel).toBe('kimi-k3');
  });

  it('только ключ Kimi, модель не выбрана — Kimi K3', async () => {
    const p = new RealAiProvider(undefined, undefined, 'claude-haiku-4-5', undefined, undefined, 'sk-kimi');
    await p.generate('с', 'в');
    expect(calls[0].body.model).toBe('kimi-k3');
  });

  it('K2.6 — без рассуждения', async () => {
    const p = new RealAiProvider(undefined, undefined, 'x', 'kimi-k2.6', undefined, 'sk-kimi');
    await p.generate('с', 'в', { maxTokens: 300 });
    expect(calls[0].body).toMatchObject({ model: 'kimi-k2.6', thinking: { type: 'disabled' }, max_completion_tokens: 300 });
  });

  it('у компании выбрана модель OpenAI — Kimi только запасной', async () => {
    const p = new RealAiProvider('sk-openai', undefined, 'x', 'gpt-4o-mini', undefined, 'sk-kimi');
    await p.generate('с', 'в');
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('Kimi не ответил — срабатывает запасной OpenAI', async () => {
    global.fetch = jest.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      if (String(url).includes('moonshot')) return new Response(JSON.stringify({ error: { message: 'rate limit' } }), { status: 429 });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'gpt' } }] }), { status: 200 });
    }) as any;
    const p = new RealAiProvider('sk-openai', undefined, 'x', 'kimi-k3', undefined, 'sk-kimi');
    expect(await p.generate('с', 'в')).toBe('gpt');
    expect(p.lastModel).toBe('gpt-4o-mini');
  });

  it('расход Kimi считается по прайсу', () => {
    expect(estimateCost('kimi-k3', 1_000_000, 1_000_000)).toBe(18);
    expect(estimateCost('kimi-k2.6', 1_000_000, 0)).toBe(0.95);
  });
});
