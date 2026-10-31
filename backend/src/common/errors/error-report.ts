import { createHash } from 'crypto';

/**
 * Сбор ошибок приложения для консоли разработчика (ТЗ консолей, §4.2–4.3): очистка и
 * группировка. Чистые функции — под тестами: очистка, которая молча пропустит токен
 * или почту, хуже, чем никакой.
 */

export type ErrorSource = 'server' | 'web' | 'mobile';

export interface ErrorReport {
  source: ErrorSource;
  kind: string;
  message: string;
  stack?: string | null;
  route?: string | null;
  version?: string | null;
  requestId?: string | null;
  tenantId?: string | null;
  userId?: string | null;
  /** Случайный id браузера/устройства — считать затронутых без персональных данных. */
  clientId?: string | null;
}

/**
 * В журнал не должны попасть почта, телефоны, токены, ключи и пароли (§4.2). Числа
 * длиннее пяти цифр тоже заменяем: в них живут id, суммы и номера телефонов, а для
 * группировки «ошибка в задаче 4705» и «в задаче 4706» — одна и та же ошибка.
 */
export function scrub(text: string | null | undefined, max = 500): string {
  return String(text ?? '')
    .replace(/Bearer\s+[\w.~+/=-]+/gi, 'Bearer <token>')
    .replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '<jwt>')
    .replace(/\b(sk|pk|rk|test|live)_[A-Za-z0-9_-]{8,}/g, '<key>')
    .replace(/((?:password|passwd|secret|token|api[_-]?key|authorization)["']?\s*[:=]\s*)["']?[^\s"',}]+/gi, '$1<hidden>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/\+?\d[\d\s()-]{9,}\d/g, '<phone>')
    .replace(/\b\d{6,}\b/g, '<n>')
    .slice(0, max);
}

/** Путь без query и с номерами вместо id: /api/tasks/4705/files?x=1 → /api/tasks/:id/files. */
export function routeOf(path: string | null | undefined): string {
  const p = String(path ?? '').split(/[?#]/)[0].slice(0, 200);
  return p
    .split('/')
    .map((seg) => (/^\d+$/.test(seg) || /^[0-9a-f-]{16,}$/i.test(seg) ? ':id' : seg))
    .join('/');
}

/** Первые строки стека — без query и с очищенными значениями. */
export function stackOf(stack: string | null | undefined, lines = 8): string | null {
  if (!stack) return null;
  return scrub(stack.split('\n').slice(0, lines).map((l) => l.replace(/\?[^\s):]*/g, '')).join('\n'), 2000);
}

/**
 * Отпечаток группы: источник, вид, сообщение без чисел и первая строка стека «в нашем
 * коде». Номер версии не входит — одна и та же ошибка в новой версии должна попадать
 * в ту же группу, иначе «исправлено» не с чем сравнить.
 */
export function fingerprint(r: Pick<ErrorReport, 'source' | 'kind' | 'message' | 'stack' | 'route'>): string {
  const msg = scrub(r.message, 300).replace(/\d+/g, '#').replace(/'[^']*'|"[^"]*"/g, '"…"');
  const frame = (r.stack ?? '').split('\n').map((l) => l.trim()).find((l) => /^at |@/.test(l) && !/node_modules|node:internal/.test(l)) ?? '';
  const where = frame.replace(/:\d+:\d+\)?$/, '').replace(/https?:\/\/[^/]+/, '').replace(/-[A-Za-z0-9_]{8}\.js/, '.js');
  return createHash('sha1').update([r.source, r.kind, msg, where, r.route ?? ''].join('|')).digest('hex');
}

/**
 * Куда отдавать ошибки сервера из фильтра исключений. Фильтр создаётся и Nest'ом, и
 * вручную в тестах; глобальная точка проще, чем протаскивать сервис в конструктор.
 * Пока сервис не поднялся — ошибки просто не собираются, фильтр работает как раньше.
 */
export const errorSink: { report: ((r: ErrorReport) => void) | null } = { report: null };
