import { fetchNet, netCode } from './ai.provider';

/*
  26.11.2026: запросы к Kimi через туннель изредка падали «fetch failed». Сразу уходили
  к запасному OpenAI — тем же путём, — и оба рвались: вместо ответа заглушка.
*/
const netError = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code } });

describe('fetchNet: один повтор при обрыве сети', () => {
  const real = global.fetch;
  afterEach(() => { global.fetch = real; });

  it('обрыв сети — повторяет и отдаёт ответ', async () => {
    const ok = new Response('{}', { status: 200 });
    const f = jest.fn().mockRejectedValueOnce(netError('ECONNRESET')).mockResolvedValueOnce(ok);
    global.fetch = f as never;
    await expect(fetchNet('https://api.moonshot.ai/v1/chat/completions', {})).resolves.toBe(ok);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('оборвалось оба раза — ошибка с кодом, адресом и временем', async () => {
    global.fetch = jest.fn().mockRejectedValue(netError('UND_ERR_SOCKET')) as never;
    await expect(fetchNet('https://api.moonshot.ai/v1/x', {})).rejects.toThrow(/UND_ERR_SOCKET, api\.moonshot\.ai, через \d+ с/);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('отмена вызывающим и ошибка без сетевого кода — без повтора', async () => {
    const ac = new AbortController();
    ac.abort();
    global.fetch = jest.fn().mockRejectedValue(netError('ECONNRESET')) as never;
    await expect(fetchNet('https://x/y', { signal: ac.signal })).rejects.toThrow();
    expect(global.fetch).toHaveBeenCalledTimes(1);

    global.fetch = jest.fn().mockRejectedValue(new Error('boom')) as never;
    await expect(fetchNet('https://x/y', {})).rejects.toThrow('boom');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('код ошибки берётся из cause', () => {
    expect(netCode(netError('ETIMEDOUT'))).toBe('ETIMEDOUT');
    expect(netCode({ cause: { name: 'SocketError' } })).toBe('UND_ERR_SOCKET');
    expect(netCode(new Error('x'))).toBeNull();
  });
});
