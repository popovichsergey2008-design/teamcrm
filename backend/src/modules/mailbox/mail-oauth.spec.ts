import { imapAuth, smtpAuth } from './mail-client';
import {
  authorizeUrl, clientFor, emailFromUserInfo, OAUTH_SPECS, RESUME_MAX, returnUrl, signState, STATE_TTL_MS, verifyState,
} from './mail-oauth';
import { firstSummary } from './mail-rules';

const SECRET = 'test-secret';
const base = { p: 'yandex' as const, t: '5', u: '42', f: 'bot' as const };

describe('mail-oauth: подписанный state', () => {
  it('свой state читается обратно вместе с просьбой боту', () => {
    const s = verifyState(signState({ ...base, r: 'Разбери почту за сегодня' }, SECRET), SECRET);
    expect(s).toMatchObject({ p: 'yandex', t: '5', u: '42', f: 'bot', r: 'Разбери почту за сегодня' });
  });

  it('просьбу обрезаем до 500 знаков, пустую не кладём', () => {
    const long = verifyState(signState({ ...base, r: 'я'.repeat(900) }, SECRET), SECRET);
    expect(long?.r).toHaveLength(RESUME_MAX);
    expect(verifyState(signState({ ...base, r: '   ' }, SECRET), SECRET)?.r).toBeUndefined();
  });

  it('чужой ключ, подмена содержимого и мусор — не принимаем', () => {
    const st = signState(base, SECRET);
    expect(verifyState(st, 'other-secret')).toBeNull();
    const [body, sig] = st.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), u: '1' })).toString('base64url');
    expect(verifyState(`${forged}.${sig}`, SECRET)).toBeNull();
    expect(verifyState('abc', SECRET)).toBeNull();
    expect(verifyState(`${st}.x`, SECRET)).toBeNull();
    expect(verifyState(undefined, SECRET)).toBeNull();
  });

  it('протухший state — не принимаем', () => {
    const now = Date.now();
    const st = signState(base, SECRET, now);
    expect(verifyState(st, SECRET, now + STATE_TTL_MS - 1000)).not.toBeNull();
    expect(verifyState(st, SECRET, now + STATE_TTL_MS + 1000)).toBeNull();
  });
});

describe('mail-oauth: почтовики', () => {
  const env = (m: Record<string, string>) => (k: string) => m[k];

  it('без ключей кнопка не настроена; Google берёт общий веб-клиент', () => {
    expect(clientFor('yandex', env({}), 'https://x/cb')).toBeNull();
    expect(clientFor('mailru', env({ MAILRU_OAUTH_CLIENT_ID: 'id' }), 'https://x/cb')).toBeNull();
    expect(clientFor('google', env({ GOOGLE_CLIENT_ID: 'gid', GOOGLE_OAUTH_CLIENT_SECRET: 's' }), 'https://x/cb'))
      .toEqual({ clientId: 'gid', clientSecret: 's', redirectUri: 'https://x/cb' });
  });

  it('адрес экрана согласия: scope почты, state и параметры почтовика', () => {
    const c = { clientId: 'cid', clientSecret: 's', redirectUri: 'https://app.qevo.one/api/mailbox/oauth/callback' };
    const y = new URL(authorizeUrl('yandex', c, 'ST'));
    expect(y.origin + y.pathname).toBe('https://oauth.yandex.ru/authorize');
    expect(y.searchParams.get('scope')).toBe('mail:imap_full mail:smtp login:email');
    expect(y.searchParams.get('state')).toBe('ST');
    expect(y.searchParams.get('redirect_uri')).toBe(c.redirectUri);
    const g = new URL(authorizeUrl('google', c, 'ST'));
    expect(g.searchParams.get('scope')).toContain('https://mail.google.com/');
    expect(g.searchParams.get('access_type')).toBe('offline');
    const m = new URL(authorizeUrl('mailru', c, 'ST'));
    expect(m.origin + m.pathname).toBe('https://oauth.mail.ru/login');
    expect(m.searchParams.get('scope')).toBe('userinfo mail.imap');
    expect(OAUTH_SPECS.google.mailProvider).toBe('gmail');
  });

  it('адрес ящика из ответа почтовика', () => {
    expect(emailFromUserInfo('yandex', { default_email: 'Ivan@Yandex.ru' })).toBe('ivan@yandex.ru');
    expect(emailFromUserInfo('yandex', { login: 'ivan' })).toBe('ivan@yandex.ru');
    expect(emailFromUserInfo('mailru', { email: 'a@mail.ru' })).toBe('a@mail.ru');
    expect(() => emailFromUserInfo('google', {})).toThrow();
  });

  it('возврат: в чат бота с просьбой или в настройки с ошибкой', () => {
    expect(returnUrl('https://app.qevo.one/', { f: 'bot', r: 'разбери почту' }, { ok: true }))
      .toBe('https://app.qevo.one/chat/qevobot?mail_connected=1&resume=%D1%80%D0%B0%D0%B7%D0%B1%D0%B5%D1%80%D0%B8+%D0%BF%D0%BE%D1%87%D1%82%D1%83');
    const bad = new URL(returnUrl('https://app.qevo.one', { f: 'settings', r: 'x' }, { ok: false, error: 'нет' }));
    expect(bad.pathname).toBe('/settings/mail');
    expect(bad.searchParams.get('mail_connected')).toBe('0');
    expect(bad.searchParams.get('mail_error')).toBe('нет');
    expect(bad.searchParams.get('resume')).toBeNull();
  });
});

describe('mail-client: вход XOAUTH2', () => {
  const box = { email: 'a@b.ru', username: 'a@b.ru', password: 'pw', imapHost: 'i', imapPort: 993, smtpHost: 's', smtpPort: 465 };

  it('с токеном — accessToken без пароля, без токена — пароль приложения', () => {
    expect(imapAuth({ ...box, accessToken: 'AT' })).toEqual({ user: 'a@b.ru', accessToken: 'AT' });
    expect(smtpAuth({ ...box, accessToken: 'AT' })).toEqual({ type: 'OAuth2', user: 'a@b.ru', accessToken: 'AT' });
    expect(imapAuth(box)).toEqual({ user: 'a@b.ru', pass: 'pw' });
    expect(smtpAuth(box)).toEqual({ user: 'a@b.ru', pass: 'pw' });
  });
});

describe('mail-rules: первый итог', () => {
  it('три числа и строка для бота', () => {
    expect(firstSummary({ critical: 6, newsletter: 190, fyi: 12, action: 6 }))
      .toEqual({ total: 214, important: 6, action: 6, skip: 202, text: '214 писем · важно 6 · ждут ответа 6 · можно не читать 202' });
    expect(firstSummary({ fyi: 1 }).text).toBe('1 письмо · важно 0 · можно не читать 1');
    expect(firstSummary({}).total).toBe(0);
  });
});
