/**
 * Клиент консолей платформы. Отдельный от CRM: свои токены (на консоль), свои маршруты
 * /api/pc/*. Токен CRM сюда не попадает, и наоборот.
 */

export type PcApp = 'owner' | 'developer' | 'support';

/** Какая консоль открыта: по поддомену; локально — ?app=… */
export function currentApp(): PcApp {
  const host = window.location.hostname;
  for (const a of ['owner', 'developer', 'support'] as const) if (host.startsWith(`${a}.`)) return a;
  const q = new URLSearchParams(window.location.search).get('app');
  return q === 'developer' || q === 'support' ? q : 'owner';
}

export const APP = currentApp();
const KEY = `pc:${APP}:tokens`;

interface Tokens { accessToken: string; refreshToken: string }

function load(): Tokens | null {
  try { return JSON.parse(localStorage.getItem(KEY) ?? 'null'); } catch { return null; }
}
let tokens: Tokens | null = load();

export function setTokens(t: Tokens | null) {
  tokens = t;
  try { if (t) localStorage.setItem(KEY, JSON.stringify(t)); else localStorage.removeItem(KEY); } catch { /* приватный режим */ }
}
export const signedIn = () => !!tokens;

export class PcError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

async function raw<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth && tokens) headers.Authorization = `Bearer ${tokens.accessToken}`;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { throw new PcError('OFFLINE', 'Нет связи с сервером'); }
  let env: { ok: boolean; data?: T; error?: { code: string; message: string } };
  try { env = await res.json(); } catch {
    throw new PcError('UNAVAILABLE', res.status >= 502 ? 'Сервер обновляется — повторите через минуту' : `Ошибка ${res.status}`);
  }
  if (!env.ok) throw new PcError(env.error?.code ?? 'INTERNAL', env.error?.message ?? 'Ошибка');
  return env.data as T;
}

let refreshing: Promise<void> | null = null;
async function refresh() {
  if (!tokens) throw new PcError('UNAUTHORIZED', 'Войдите');
  refreshing ??= raw<Tokens>('POST', '/pc/auth/refresh', { refreshToken: tokens.refreshToken, app: APP }, false)
    .then(setTokens)
    .catch((e) => { setTokens(null); window.dispatchEvent(new Event('pc:signed-out')); throw e; })
    .finally(() => { refreshing = null; });
  return refreshing;
}

export async function pc<T>(method: string, path: string, body?: unknown): Promise<T> {
  try { return await raw<T>(method, path, body); } catch (e) {
    if (e instanceof PcError && e.code === 'UNAUTHORIZED' && tokens) {
      await refresh();
      return raw<T>(method, path, body);
    }
    throw e;
  }
}

export const pcPublic = <T,>(path: string, body: unknown) => raw<T>('POST', path, body, false);

export async function signOut() {
  const t = tokens;
  setTokens(null);
  if (t) await raw('POST', '/pc/auth/logout', { refreshToken: t.refreshToken }, false).catch(() => undefined);
  window.dispatchEvent(new Event('pc:signed-out'));
}

export interface Me { id: string; email: string; name: string; app: PcApp; roles: string[]; perms: string[] }

export const fmtNum = (n: number) => new Intl.NumberFormat('ru-RU').format(n);
export const fmtDate = (s: string | null | undefined) => (s ? new Date(s).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—');
