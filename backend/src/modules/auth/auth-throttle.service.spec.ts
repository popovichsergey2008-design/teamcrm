import { AuthThrottleService, RULES, waitText } from './auth-throttle.service';
import { AppException } from '../../common/http/app-exception';

/** Redis в памяти: ровно те команды, что зовёт счётчик. */
function fakeRedis() {
  const store = new Map<string, { v: number; ttl: number }>();
  const client = {
    multi() {
      const ops: (() => [null, unknown])[] = [];
      const chain = {
        incr(k: string) { ops.push(() => { const e = store.get(k) ?? { v: 0, ttl: -1 }; e.v++; store.set(k, e); return [null, e.v]; }); return chain; },
        get(k: string) { ops.push(() => [null, store.has(k) ? String(store.get(k)!.v) : null]); return chain; },
        ttl(k: string) { ops.push(() => [null, store.get(k)?.ttl ?? -2]); return chain; },
        exec: async () => ops.map((f) => f()),
      };
      return chain;
    },
    async incr(k: string) { const e = store.get(k) ?? { v: 0, ttl: -1 }; e.v++; store.set(k, e); return e.v; },
    async expire(k: string, s: number) { const e = store.get(k); if (e) e.ttl = s; return 1; },
    async del(k: string) { store.delete(k); return 1; },
  };
  return { client } as any;
}

describe('AuthThrottleService', () => {
  const prev = process.env.AUTH_THROTTLE;
  beforeAll(() => { process.env.AUTH_THROTTLE = 'on'; });
  afterAll(() => { process.env.AUTH_THROTTLE = prev; });

  it('пропускает до предела и отказывает сверх него с 429', async () => {
    const t = new AuthThrottleService(fakeRedis());
    for (let i = 0; i < RULES.registerIp.limit; i++) await t.hit(RULES.registerIp, '1.2.3.4');
    const err = await t.hit(RULES.registerIp, '1.2.3.4').catch((e) => e);
    expect(err).toBeInstanceOf(AppException);
    expect(err.getStatus()).toBe(429);
    expect(err.message).toMatch(/Повторите через/);
    // другой адрес считается отдельно
    await expect(t.hit(RULES.registerIp, '5.6.7.8')).resolves.toBeUndefined();
  });

  it('неудачи по почте: check закрывает после предела, reset открывает', async () => {
    const t = new AuthThrottleService(fakeRedis());
    for (let i = 0; i < RULES.loginFail.limit; i++) {
      await t.check(RULES.loginFail, 'A@b.c');
      await t.fail(RULES.loginFail, 'a@b.c');
    }
    await expect(t.check(RULES.loginFail, 'a@B.c')).rejects.toBeInstanceOf(AppException);
    await t.reset(RULES.loginFail, 'a@b.c');
    await expect(t.check(RULES.loginFail, 'a@b.c')).resolves.toBeUndefined();
  });

  it('Redis недоступен — вход не закрываем', async () => {
    const broken = { client: { multi: () => { throw new Error('down'); }, incr: async () => { throw new Error('down'); } } } as any;
    const t = new AuthThrottleService(broken);
    await expect(t.hit(RULES.loginIp, '1.1.1.1')).resolves.toBeUndefined();
    await expect(t.fail(RULES.loginFail, 'x@y.z')).resolves.toBe(0);
  });

  it('срок словами', () => {
    expect(waitText(30)).toBe('1 мин');
    expect(waitText(15 * 60)).toBe('15 мин');
    expect(waitText(2 * 3600)).toBe('2 ч');
  });
});
