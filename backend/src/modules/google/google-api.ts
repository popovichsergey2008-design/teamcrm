/**
 * Низкий уровень обращения к Google: обмен кода, обновление токена и вызовы API.
 *
 * Здесь нет ни базы, ни Nest — только HTTP и разбор ошибок, чтобы правила повторов
 * и классификацию ошибок можно было проверить тестом без сети.
 */

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

/**
 * Разрешения — самые узкие из тех, что закрывают сценарий (§13–15 ТЗ).
 * drive.file — только файлы, которые человек сам выбрал в окне Google или которые
 * создали мы; весь Диск (scope drive) не просим: это и лишний доступ, и тяжёлая проверка Google.
 */
export const SCOPES = {
  base: ['openid', 'email', 'profile'],
  drive: ['https://www.googleapis.com/auth/drive.file'],
  calendar: [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  ],
} as const;

export type GoogleService = 'drive' | 'calendar' | 'all';

export function scopesFor(service: GoogleService): string[] {
  const s: string[] = [...SCOPES.base];
  if (service === 'drive' || service === 'all') s.push(...SCOPES.drive);
  if (service === 'calendar' || service === 'all') s.push(...SCOPES.calendar);
  return s;
}

/** Что из сервисов покрыто выданными разрешениями. */
export function grantedServices(scopes: string[]): { drive: boolean; calendar: boolean } {
  const has = (list: readonly string[]) => list.every((x) => scopes.includes(x));
  return { drive: has(SCOPES.drive), calendar: has(SCOPES.calendar) };
}

/**
 * Ошибка Google в понятном нам виде.
 *  - reconnect — доступ отозван или протух (invalid_grant, 401 после обновления): нужно
 *    переподключить Google, повторять бессмысленно;
 *  - scope — разрешения не хватает (человек снял галочку на экране согласия);
 *  - retry — временная (429, 5xx): повторяем с паузой;
 *  - other — 403/404 и прочее: показываем человеку как есть.
 */
export type GoogleErrorKind = 'reconnect' | 'scope' | 'retry' | 'other';

export class GoogleApiError extends Error {
  constructor(readonly status: number, readonly kind: GoogleErrorKind, message: string, readonly reason?: string) {
    super(message);
  }
}

export function classifyGoogleError(status: number, body: any): GoogleApiError {
  const err = body?.error;
  const code = typeof err === 'string' ? err : (err?.status ?? err?.errors?.[0]?.reason ?? '');
  const message = String(body?.error_description ?? err?.message ?? (typeof err === 'string' ? err : '') ?? '').slice(0, 300)
    || `Google ответил ${status}`;
  const reason = String(err?.errors?.[0]?.reason ?? code ?? '');
  if (code === 'invalid_grant' || status === 401) return new GoogleApiError(status, 'reconnect', message, reason);
  if (/insufficient|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(`${reason} ${message} ${err?.details?.[0]?.reason ?? ''}`)) {
    return new GoogleApiError(status, 'scope', message, reason);
  }
  // rateLimitExceeded приходит и с 403 — это тоже «подождать», а не «нет прав»
  if (status === 429 || status >= 500 || /rateLimitExceeded|userRateLimitExceeded/.test(reason)) {
    return new GoogleApiError(status, 'retry', message, reason);
  }
  return new GoogleApiError(status, 'other', message, reason);
}

export interface TokenSet {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
}

async function postForm(url: string, form: Record<string, string>): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw classifyGoogleError(res.status, body);
  return body;
}

export function exchangeCode(code: string, cfg: { clientId: string; clientSecret: string; redirectUri: string }): Promise<TokenSet> {
  return postForm(TOKEN_URL, {
    code, client_id: cfg.clientId, client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri, grant_type: 'authorization_code',
  });
}

export function refreshAccessToken(refreshToken: string, cfg: { clientId: string; clientSecret: string }): Promise<TokenSet> {
  return postForm(TOKEN_URL, {
    refresh_token: refreshToken, client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'refresh_token',
  });
}

/** Отзыв доступа в самом Google. Ошибку глотаем: отключить у нас нужно в любом случае. */
export async function revokeToken(token: string): Promise<void> {
  await postForm(REVOKE_URL, { token }).catch(() => undefined);
}

export async function fetchUserInfo(accessToken: string): Promise<{ sub: string; email: string; name?: string }> {
  return googleJson(USERINFO_URL, accessToken);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Вызов API Google с токеном. Временные ошибки (429/5xx) повторяем до трёх раз
 * с растущей паузой (§92); остальные — сразу наверх, бесконечно не повторяем.
 */
export async function googleJson<T = any>(
  url: string,
  accessToken: string,
  init: { method?: string; body?: unknown; query?: Record<string, string | number | boolean | undefined> } = {},
): Promise<T> {
  const u = new URL(url);
  for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
  let last: GoogleApiError | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(400 * 2 ** attempt);
    const res = await fetch(u, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 204) return undefined as T;
    const body = await res.json().catch(() => ({}));
    if (res.ok) return body as T;
    last = classifyGoogleError(res.status, body);
    if (last.kind !== 'retry') throw last;
  }
  throw last!;
}
