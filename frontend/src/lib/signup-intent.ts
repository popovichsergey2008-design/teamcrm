/**
 * С чем пришли с сайта (#4779, п. 1): кнопки сайта ведут на app.qevo.one/register
 * или /login, с UTM-метками и текстом задачи из демо (`?task=…`). Читаем адрес один
 * раз при загрузке — после входа он сменится на /focus — и держим до конца
 * регистрации: метки уходят с ней на сервер, задача создаётся после знакомства.
 */
const KEY = 'qevo.signup';
type Intent = { utm?: Record<string, string>; task?: string; at: number };

function read(): Intent | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Intent | null;
    // неделя: человек мог вернуться к регистрации не сразу
    return v && Date.now() - v.at < 7 * 86_400_000 ? v : null;
  } catch { return null; }
}

/** Какой экран открыть: кнопка «Регистрация» — регистрацию, «Войти» — вход. */
export const signupMode: 'register' | 'login' | null = (() => {
  if (typeof window === 'undefined') return null;
  const path = window.location.pathname.replace(/\/+$/, '');
  const q = new URLSearchParams(window.location.search);
  if (path === '/register' || path === '/signup' || q.get('signup') === '1') return 'register';
  if (path === '/login' || path === '/signin') return 'login';
  return null;
})();

(() => {
  if (typeof window === 'undefined') return;
  const q = new URLSearchParams(window.location.search);
  const utm: Record<string, string> = {};
  q.forEach((v, k) => { if (/^utm_[a-z_]{1,20}$/.test(k) && v.trim()) utm[k] = v.trim().slice(0, 200); });
  const task = (q.get('task') ?? q.get('demo_task') ?? '').trim().slice(0, 500);
  if (!Object.keys(utm).length && !task) return;
  const prev = read();
  const next: Intent = { utm: Object.keys(utm).length ? utm : prev?.utm, task: task || prev?.task, at: Date.now() };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* без хранилища — без меток */ }
})();

export function signupUtm(): Record<string, string> | undefined { return read()?.utm; }
export function signupTask(): string | null { return read()?.task ?? null; }
export function clearSignupTask(): void {
  const v = read();
  if (!v) return;
  try { localStorage.setItem(KEY, JSON.stringify({ ...v, task: undefined })); } catch { /* ничего */ }
}
/** Адрес входа/регистрации после входа больше не нужен — ведём в «Фокус дня». */
export function isAuthPath(): boolean {
  return /^\/(register|signup|login|signin)\/?$/.test(window.location.pathname);
}
