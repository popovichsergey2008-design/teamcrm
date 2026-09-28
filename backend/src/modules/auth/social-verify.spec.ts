import { createHash, createHmac } from 'crypto';
import { googleProfile, TELEGRAM_MAX_AGE_MS, telegramProfile } from './social-verify';

describe('вход через Google', () => {
  const now = new Date('2026-09-28T12:00:00.000Z');
  const ok = {
    aud: 'our-app.apps.googleusercontent.com',
    sub: '1234567890',
    email: 'Olga@Company.RU',
    email_verified: true,
    name: 'Ольга Владелец',
    exp: Math.floor(now.getTime() / 1000) + 600,
  };

  it('принимает свой подтверждённый токен и приводит почту к нижнему регистру', () => {
    const p = googleProfile(ok, ok.aud, now);
    expect(p).toEqual({
      externalId: '1234567890', email: 'olga@company.ru',
      fullName: 'Ольга Владелец', provider: 'google',
    });
  });

  it('чужой токен не пускает даже валидный', () => {
    // без этой проверки токен, выписанный ЛЮБОМУ приложению Google, открывал бы вход
    expect(() => googleProfile(ok, 'another-app', now)).toThrow(/другому приложению/);
    expect(() => googleProfile(ok, '', now)).toThrow(/другому приложению/);
  });

  it('просроченный токен не пускает', () => {
    const old = { ...ok, exp: Math.floor(now.getTime() / 1000) - 10 };
    expect(() => googleProfile(old, ok.aud, now)).toThrow(/просрочен/);
  });

  it('неподтверждённый адрес не пускает', () => {
    // чужой неподтверждённый адрес можно занять и войти в аккаунт, заведённый по почте
    expect(() => googleProfile({ ...ok, email_verified: false }, ok.aud, now)).toThrow(/не подтвердил/);
    expect(() => googleProfile({ ...ok, email: '' }, ok.aud, now)).toThrow(/не подтвердил/);
  });

  it('без имени берём начало адреса, а не пустую строку', () => {
    expect(googleProfile({ ...ok, name: '' }, ok.aud, now).fullName).toBe('olga');
  });
});

describe('вход через Telegram', () => {
  const token = '123456:AA-test-bot-token';
  const now = new Date('2026-09-28T12:00:00.000Z');
  const sign = (data: Record<string, string>) => {
    const check = Object.keys(data).sort().map((k) => `${k}=${data[k]}`).join('\n');
    const secret = createHash('sha256').update(token).digest();
    return createHmac('sha256', secret).update(check).digest('hex');
  };
  const fresh = () => {
    const data: Record<string, string> = {
      id: '99887766',
      first_name: 'Пётр',
      last_name: 'Коллега',
      username: 'petr',
      auth_date: String(Math.floor(now.getTime() / 1000) - 60),
    };
    return { ...data, hash: sign(data) };
  };

  it('принимает свою подпись и опознаёт по id, а не по имени пользователя', () => {
    const p = telegramProfile(fresh(), token, now);
    expect(p.externalId).toBe('99887766');
    expect(p.fullName).toBe('Пётр Коллега');
    // почты Telegram не даёт вовсе — это не ошибка, а свойство входа
    expect(p.email).toBeNull();
  });

  it('подделанную подпись не принимает', () => {
    const data = fresh();
    expect(() => telegramProfile({ ...data, hash: 'нетакой' }, token, now)).toThrow(/не сходится/);
    // подменили поле, подпись осталась прежней
    expect(() => telegramProfile({ ...data, id: '11111111' }, token, now)).toThrow(/не сходится/);
  });

  it('чужим токеном бота не пускает', () => {
    expect(() => telegramProfile(fresh(), 'другой-токен', now)).toThrow(/не сходится/);
    expect(() => telegramProfile(fresh(), '', now)).toThrow(/не настроен/);
  });

  it('старую подпись не принимает: её могли где-то подобрать', () => {
    const data: Record<string, string> = {
      id: '99887766', first_name: 'Пётр',
      auth_date: String(Math.floor((now.getTime() - TELEGRAM_MAX_AGE_MS - 60_000) / 1000)),
    };
    expect(() => telegramProfile({ ...data, hash: sign(data) }, token, now)).toThrow(/просрочен/);
  });

  it('без подписи не пускает', () => {
    const { hash, ...rest } = fresh();
    expect(hash).toBeTruthy();
    expect(() => telegramProfile(rest, token, now)).toThrow(/не прислал подпись/);
  });
});
