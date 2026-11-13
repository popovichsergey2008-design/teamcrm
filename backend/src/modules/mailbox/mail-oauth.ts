import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Подключение почты кнопкой (#4893, п. 2): вход через Яндекс, Google, Mail.ru по OAuth
 * вместо пароля приложения. Пароль приложения — двадцать шагов по чужим настройкам,
 * на которых теряется почти каждый; кнопка — двадцать секунд.
 *
 * Здесь нет ни базы, ни Nest — только описание почтовиков, подпись state и HTTP к
 * их серверам авторизации, чтобы подпись и сборку адресов можно было проверить тестом.
 * Читаем и пишем потом тем же IMAP/SMTP, только вход — XOAUTH2 с access-токеном:
 * весь остальной разбор почты (входящие, поиск, черновики) не меняется.
 */

export type OAuthMailProvider = 'yandex' | 'google' | 'mailru';
export const OAUTH_MAIL_PROVIDERS: OAuthMailProvider[] = ['yandex', 'google', 'mailru'];

export interface OAuthProviderSpec {
  title: string;
  /** Как почтовик записан в mail_accounts.provider — по нему работают прежние правила (Gmail сам кладёт копию в «Отправленные»). */
  mailProvider: 'yandex' | 'gmail' | 'mailru';
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  imap: [string, number];
  smtp: [string, number];
  /** Mail.ru принимает ключ клиента только заголовком Basic, Яндекс и Google — полями формы. */
  clientAuth: 'basic' | 'body';
  /** Имена переменных окружения с ключами приложения. */
  env: { id: string[]; secret: string[] };
  /** Добавки к адресу экрана согласия: без них refresh-токена не будет или войдут не в тот ящик. */
  extraAuthParams: Record<string, string>;
}

export const OAUTH_SPECS: Record<OAuthMailProvider, OAuthProviderSpec> = {
  yandex: {
    title: 'Яндекс',
    mailProvider: 'yandex',
    authorizeUrl: 'https://oauth.yandex.ru/authorize',
    tokenUrl: 'https://oauth.yandex.ru/token',
    // login:email — чтобы узнать адрес ящика; без него IMAP не на кого войти
    scopes: ['mail:imap_full', 'mail:smtp', 'login:email'],
    imap: ['imap.yandex.ru', 993],
    smtp: ['smtp.yandex.ru', 465],
    clientAuth: 'body',
    env: { id: ['YANDEX_OAUTH_CLIENT_ID'], secret: ['YANDEX_OAUTH_CLIENT_SECRET'] },
    // force_confirm — показать выбор аккаунта: в браузере часто залогинен «не тот» Яндекс
    extraAuthParams: { force_confirm: 'yes' },
  },
  google: {
    title: 'Google',
    mailProvider: 'gmail',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    // IMAP/SMTP Gmail пускает только с полным scope mail.google.com — узкие (gmail.readonly) для IMAP не годятся
    scopes: ['openid', 'email', 'https://mail.google.com/'],
    imap: ['imap.gmail.com', 993],
    smtp: ['smtp.gmail.com', 465],
    clientAuth: 'body',
    // тот же веб-клиент, что у Диска и Календаря (#1565)
    env: { id: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_CLIENT_ID'], secret: ['GOOGLE_OAUTH_CLIENT_SECRET'] },
    // offline + consent — иначе Google не выдаст refresh-токен и доступ умрёт через час
    extraAuthParams: { access_type: 'offline', prompt: 'consent select_account' },
  },
  mailru: {
    title: 'Mail.ru',
    mailProvider: 'mailru',
    authorizeUrl: 'https://oauth.mail.ru/login',
    tokenUrl: 'https://oauth.mail.ru/token',
    // mail.imap у Mail.ru открывает и IMAP, и SMTP; userinfo — адрес ящика
    scopes: ['userinfo', 'mail.imap'],
    imap: ['imap.mail.ru', 993],
    smtp: ['smtp.mail.ru', 465],
    clientAuth: 'basic',
    env: { id: ['MAILRU_OAUTH_CLIENT_ID'], secret: ['MAILRU_OAUTH_CLIENT_SECRET'] },
    extraAuthParams: { prompt_force: '1' },
  },
};

export function isOAuthProvider(v: unknown): v is OAuthMailProvider {
  return typeof v === 'string' && (OAUTH_MAIL_PROVIDERS as string[]).includes(v);
}

export interface OAuthClient { clientId: string; clientSecret: string; redirectUri: string }

/** Ключи приложения из окружения: первое непустое имя из списка. Нет ключей — null, кнопка скажет «ещё не подключено». */
export function clientFor(p: OAuthMailProvider, env: (k: string) => unknown, redirectUri: string): OAuthClient | null {
  const pick = (names: string[]) => names.map((n) => String(env(n) ?? '').trim()).find(Boolean) ?? '';
  const spec = OAUTH_SPECS[p];
  const clientId = pick(spec.env.id);
  const clientSecret = pick(spec.env.secret);
  return clientId && clientSecret ? { clientId, clientSecret, redirectUri } : null;
}

// ── state: кто начал вход и что он просил ──

/**
 * Содержимое state. Хранить его в базе незачем: подпись не даёт подделать «кто», а срок
 * жизни — переиграть старую ссылку. resume — исходная просьба боту («разбери почту»):
 * после входа бот выполнит её сам, человеку не нужно повторять.
 */
export interface MailOAuthState {
  p: OAuthMailProvider;
  t: string;
  u: string;
  /** Куда вернуть: в чат бота или в «Настройки → Почта». */
  f: 'bot' | 'settings';
  r?: string;
  /** Истекает (мс с 1970). */
  e: number;
  n: string;
}

export const STATE_TTL_MS = 10 * 60_000;
export const RESUME_MAX = 500;

const b64u = (b: Buffer) => b.toString('base64url');

function mac(body: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(`mail-oauth:${body}`).digest();
}

export function signState(s: Omit<MailOAuthState, 'e' | 'n'>, secret: string, now = Date.now()): string {
  const r = s.r?.trim().slice(0, RESUME_MAX);
  const full: MailOAuthState = { p: s.p, t: s.t, u: s.u, f: s.f, ...(r ? { r } : {}), e: now + STATE_TTL_MS, n: randomBytes(6).toString('hex') };
  const body = b64u(Buffer.from(JSON.stringify(full), 'utf8'));
  return `${body}.${b64u(mac(body, secret))}`;
}

/** Чужой, испорченный или протухший state — null: такой возврат не принимаем. */
export function verifyState(state: string | undefined | null, secret: string, now = Date.now()): MailOAuthState | null {
  if (!state || state.length > 4000) return null;
  const [body, sig, extra] = state.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const want = mac(body, secret);
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let s: MailOAuthState;
  try {
    s = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!s || !isOAuthProvider(s.p) || !s.t || !s.u || typeof s.e !== 'number' || s.e < now) return null;
  if (s.f !== 'bot' && s.f !== 'settings') return null;
  if (s.r !== undefined && (typeof s.r !== 'string' || s.r.length > RESUME_MAX)) return null;
  return s;
}

/** Адрес экрана согласия почтовика. */
export function authorizeUrl(p: OAuthMailProvider, c: OAuthClient, state: string, loginHint?: string | null): string {
  const spec = OAUTH_SPECS[p];
  const u = new URL(spec.authorizeUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', c.clientId);
  u.searchParams.set('redirect_uri', c.redirectUri);
  u.searchParams.set('scope', spec.scopes.join(' '));
  u.searchParams.set('state', state);
  for (const [k, v] of Object.entries(spec.extraAuthParams)) u.searchParams.set(k, v);
  if (loginHint) u.searchParams.set('login_hint', loginHint);
  return u.toString();
}

/** Куда вернуть человека после входа. Просьбу боту несём в адресе — экран бота выполнит её сам. */
export function returnUrl(base: string, s: Pick<MailOAuthState, 'f' | 'r'> | null, result: { ok: boolean; error?: string }): string {
  const path = s?.f === 'settings' ? '/settings/mail' : '/chat/qevobot';
  const q = new URLSearchParams();
  q.set('mail_connected', result.ok ? '1' : '0');
  if (!result.ok && result.error) q.set('mail_error', result.error.slice(0, 300));
  if (result.ok && s?.r) q.set('resume', s.r);
  return `${base.replace(/\/+$/, '')}${path}?${q.toString()}`;
}

// ── токены ──

export interface OAuthTokens { access_token: string; expires_in?: number; refresh_token?: string }

/**
 * Ошибка сервера авторизации. reconnect — доступ отозван или ключ обновления больше не
 * принимают (invalid_grant): повторять бесполезно, нужно войти заново.
 */
export class MailOAuthError extends Error {
  constructor(readonly reconnect: boolean, message: string) { super(message); }
}

async function postToken(p: OAuthMailProvider, c: OAuthClient, form: Record<string, string>): Promise<OAuthTokens> {
  const spec = OAUTH_SPECS[p];
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  const body: Record<string, string> = { ...form };
  if (spec.clientAuth === 'basic') {
    headers.Authorization = `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64')}`;
  } else {
    body.client_id = c.clientId;
    body.client_secret = c.clientSecret;
  }
  const res = await fetch(spec.tokenUrl, {
    method: 'POST', headers, body: new URLSearchParams(body).toString(), signal: AbortSignal.timeout(15_000),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json?.access_token) {
    const code = String(json?.error ?? res.status);
    const msg = String(json?.error_description ?? code).slice(0, 200);
    throw new MailOAuthError(code === 'invalid_grant' || code === 'invalid_token' || res.status === 401, msg);
  }
  return json as OAuthTokens;
}

export function exchangeCode(p: OAuthMailProvider, c: OAuthClient, code: string): Promise<OAuthTokens> {
  return postToken(p, c, { grant_type: 'authorization_code', code, redirect_uri: c.redirectUri });
}

export function refreshToken(p: OAuthMailProvider, c: OAuthClient, refresh: string): Promise<OAuthTokens> {
  return postToken(p, c, { grant_type: 'refresh_token', refresh_token: refresh });
}

/** Адрес ящика, в который вошли: у каждого почтовика своя ручка и своё имя поля. */
export async function fetchEmail(p: OAuthMailProvider, accessToken: string): Promise<string> {
  let url: string;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (p === 'yandex') {
    url = 'https://login.yandex.ru/info?format=json';
    headers.Authorization = `OAuth ${accessToken}`;
  } else if (p === 'google') {
    url = 'https://openidconnect.googleapis.com/v1/userinfo';
    headers.Authorization = `Bearer ${accessToken}`;
  } else {
    url = `https://oauth.mail.ru/userinfo?access_token=${encodeURIComponent(accessToken)}`;
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new MailOAuthError(false, `Не удалось узнать адрес ящика (${res.status})`);
  return emailFromUserInfo(p, json);
}

/** Разбор ответа userinfo — отдельно, чтобы проверить тестом. Яндекс без login:email отдаёт только логин. */
export function emailFromUserInfo(p: OAuthMailProvider, info: any): string {
  const raw = p === 'yandex'
    ? (info?.default_email || (Array.isArray(info?.emails) && info.emails[0]) || (info?.login ? `${info.login}@yandex.ru` : ''))
    : info?.email;
  const email = String(raw ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new MailOAuthError(false, 'Почтовик не сообщил адрес ящика');
  return email;
}
