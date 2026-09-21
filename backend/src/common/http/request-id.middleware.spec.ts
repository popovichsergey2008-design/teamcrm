import { requestId, requestIdOf } from './request-id.middleware';

/** Номер запроса: свой принимаем, чужой мусор — нет, без номера — выдаём. */
describe('request-id', () => {
  const run = (header?: string) => {
    const req: any = { header: (n: string) => (n === 'X-Request-Id' ? header : undefined) };
    const headers: Record<string, string> = {};
    const res: any = { setHeader: (k: string, v: string) => { headers[k] = v; } };
    let called = false;
    requestId(req, res, () => { called = true; });
    return { req, headers, called };
  };

  it('без заголовка — выдаёт свой и кладёт в ответ', () => {
    const { req, headers, called } = run();
    expect(called).toBe(true);
    expect(requestIdOf(req)).toMatch(/^[0-9a-f]{16}$/);
    expect(headers['X-Request-Id']).toBe(requestIdOf(req));
  });

  it('свой номер клиента принимает как есть', () => {
    const { req, headers } = run('retry-7f3a.1');
    expect(requestIdOf(req)).toBe('retry-7f3a.1');
    expect(headers['X-Request-Id']).toBe('retry-7f3a.1');
  });

  it('мусор в заголовке не пускает в журнал — выдаёт свой', () => {
    expect(requestIdOf(run('<script>').req)).toMatch(/^[0-9a-f]{16}$/);
    expect(requestIdOf(run('x'.repeat(65)).req)).toMatch(/^[0-9a-f]{16}$/);
    expect(requestIdOf(run('ab').req)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('два запроса — два разных номера', () => {
    expect(requestIdOf(run().req)).not.toBe(requestIdOf(run().req));
  });
});
