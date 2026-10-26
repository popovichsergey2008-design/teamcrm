import { createHmac } from 'crypto';
import { signWebAppInitData, verifyWebAppInitData, WEBAPP_MAX_AGE_MS } from './telegram-webapp-verify';

const TOKEN = '123456:TEST-token';
const NOW = new Date('2026-10-26T10:00:00Z');
const sec = (d: Date) => String(Math.floor(d.getTime() / 1000));
const fields = (over: Record<string, string> = {}) => ({
  auth_date: sec(NOW),
  query_id: 'AAE1',
  user: JSON.stringify({ id: 777000111, first_name: 'Дмитрий', language_code: 'ru' }),
  ...over,
});

describe('verifyWebAppInitData (#4619 Mini App)', () => {
  it('корректная подпись — Telegram ID из поля user', () => {
    const r = verifyWebAppInitData(signWebAppInitData(fields(), TOKEN), TOKEN, NOW);
    expect(r.telegramUserId).toBe('777000111');
    expect(r.firstName).toBe('Дмитрий');
    expect(r.startParam).toBeNull();
  });

  it('ключ выведен из "WebAppData", а не из sha256(токена) как у виджета входа', () => {
    // считаем вручную, независимо от signWebAppInitData
    const f = fields({ start_param: 'task_42' });
    const check = Object.keys(f).sort().map((k) => `${k}=${(f as any)[k]}`).join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
    const hash = createHmac('sha256', secret).update(check).digest('hex');
    const initData = new URLSearchParams({ ...f, hash }).toString();
    expect(verifyWebAppInitData(initData, TOKEN, NOW).startParam).toBe('task_42');
  });

  it('подмена поля после подписи — отказ', () => {
    const good = signWebAppInitData(fields(), TOKEN);
    const p = new URLSearchParams(good);
    p.set('user', JSON.stringify({ id: 1, first_name: 'Злоумышленник' }));
    expect(() => verifyWebAppInitData(p.toString(), TOKEN, NOW)).toThrow(/Подпись/);
  });

  it('подпись чужим токеном — отказ', () => {
    expect(() => verifyWebAppInitData(signWebAppInitData(fields(), '999:other'), TOKEN, NOW)).toThrow(/Подпись/);
  });

  it('просрочено: auth_date старше часа', () => {
    const old = new Date(NOW.getTime() - WEBAPP_MAX_AGE_MS - 1000);
    expect(() => verifyWebAppInitData(signWebAppInitData(fields({ auth_date: sec(old) }), TOKEN), TOKEN, NOW)).toThrow(/устарели/);
  });

  it('свежее часа — проходит', () => {
    const fresh = new Date(NOW.getTime() - WEBAPP_MAX_AGE_MS + 60_000);
    expect(verifyWebAppInitData(signWebAppInitData(fields({ auth_date: sec(fresh) }), TOKEN), TOKEN, NOW).telegramUserId).toBe('777000111');
  });

  it('нет hash — отказ', () => {
    const p = new URLSearchParams(signWebAppInitData(fields(), TOKEN));
    p.delete('hash');
    expect(() => verifyWebAppInitData(p.toString(), TOKEN, NOW)).toThrow(/подпись/);
  });

  it('нет auth_date или user — отказ', () => {
    const noDate: Record<string, string> = fields();
    delete noDate.auth_date;
    expect(() => verifyWebAppInitData(signWebAppInitData(noDate, TOKEN), TOKEN, NOW)).toThrow(/устарели/);
    const noUser: Record<string, string> = fields();
    delete noUser.user;
    expect(() => verifyWebAppInitData(signWebAppInitData(noUser, TOKEN), TOKEN, NOW)).toThrow(/идентификатор/);
  });

  it('без токена бота и с пустой строкой — отказ', () => {
    expect(() => verifyWebAppInitData(signWebAppInitData(fields(), TOKEN), '', NOW)).toThrow(/не настроен/);
    expect(() => verifyWebAppInitData('', TOKEN, NOW)).toThrow();
  });
});
