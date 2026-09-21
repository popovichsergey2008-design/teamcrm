import type { SupportContextInput } from '../types';
import { platform } from '../platform';

/**
 * Технический контекст обращения (ТЗ-8, разд. 15–16).
 *
 * Собираем ровно то, что человек и так видит на экране: где он был, в какой сущности,
 * в каком браузере и какая ошибка мелькнула последней. Специалисту это экономит
 * первые три вопроса («а где вы были?», «а что именно нажали?»), а человеку — время.
 *
 * Чего здесь нет и не будет: токенов, паролей, буфера обмена, содержимого чужих
 * чатов и файлов, персональных данных вне текущего экрана. Это не только правило
 * ТЗ — это единственная причина, по которой контекст вообще можно собирать молча.
 * Сервер принимает такой же разрешённый список полей, так что лишнее не проедет
 * даже случайно.
 */

/** Последняя ошибка на экране — её и спрашивают первым делом. */
let lastError: { text: string; requestId?: string } | null = null;
/** Номер последнего запроса к серверу — нитка к строке в журнале (волна 10). */
let lastRequestId: string | null = null;

/** Запомнить ошибку. Зовётся из перехватчика ответов и из обработчика сбоев окна. */
export function noteSupportError(text: string, requestId?: string): void {
  const clean = String(text ?? '').trim().slice(0, 500);
  if (!clean) return;
  lastError = { text: clean, requestId: requestId ?? lastRequestId ?? undefined };
}

/** Запомнить номер запроса из ответа сервера — любого, не только с ошибкой. */
export function noteRequestId(id: string | null | undefined): void {
  if (id) lastRequestId = String(id).slice(0, 64);
}

/**
 * Ловить сбои окна: исключение в обработчике, отвергнутое обещание без catch.
 * Человек видит «что-то сломалось» — специалист увидит, что именно. Ставится один раз
 * при старте; текст сбоя режется, стек не шлём — в нём бывают адреса с параметрами.
 */
export function installSupportErrorCapture(): void {
  try {
    window.addEventListener('error', (e) => noteSupportError(e.message || 'Сбой на странице'));
    window.addEventListener('unhandledrejection', (e) => {
      const r = (e as PromiseRejectionEvent).reason as { message?: string } | string | undefined;
      noteSupportError(typeof r === 'string' ? r : r?.message || 'Необработанный сбой');
    });
  } catch { /* вне браузера */ }
}

/** Короткое имя браузера: «Chrome 141» вместо трёх строк user-agent. */
function browserName(ua: string): string {
  const m = /(Edg|OPR|Chrome|Firefox|Safari)\/(\d+)/.exec(ua);
  if (!m) return ua.slice(0, 80);
  const names: Record<string, string> = { Edg: 'Edge', OPR: 'Opera' };
  return `${names[m[1]] ?? m[1]} ${m[2]}`;
}

function osName(ua: string): string {
  if (/Windows NT 10/.test(ua)) return 'Windows 10/11';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Android/.test(ua)) return 'Android';
  if (/iPhone|iPad/.test(ua)) return 'iOS';
  if (/Mac OS X/.test(ua)) return 'macOS';
  if (/Linux/.test(ua)) return 'Linux';
  return 'неизвестно';
}

/** Что за сущность открыта прямо сейчас: задача, проект, чат. Берём из адреса. */
function entityFrom(path: string): { entityType?: string; entityId?: string } {
  const seg = path.split('/').filter(Boolean);
  if (seg[0] === 'projects' && seg[2] === 'task' && seg[3]) return { entityType: 'task', entityId: seg[3] };
  if (seg[0] === 'projects' && seg[1]) return { entityType: 'project', entityId: seg[1] };
  if (seg[0] === 'chat' && seg[1]) return { entityType: 'chat', entityId: seg[1] };
  if (seg[0] === 'tasks' && seg[1]) return { entityType: 'registry', entityId: seg[1] };
  return {};
}

/** Сеть: есть ли, и какая — на телефоне «edge в метро» объясняет половину жалоб. */
function networkName(): string {
  if (navigator.onLine === false) return 'offline';
  const c = (navigator as Navigator & { connection?: { effectiveType?: string } }).connection;
  return c?.effectiveType ? `online · ${c.effectiveType}`.slice(0, 24) : 'online';
}

export function collectSupportContext(): SupportContextInput {
  const ua = navigator.userAgent ?? '';
  const path = window.location.pathname;
  // Где запущен фронт и какая сборка — из моста в ОС: в оболочке это версия
  // приложения и модель телефона, в браузере — версия бандла (волна 10).
  const info = platform.info();
  return {
    url: window.location.href.slice(0, 500),
    route: path.split('/').filter(Boolean)[0] || 'focus',
    ...entityFrom(path),
    browser: browserName(ua),
    os: osName(ua),
    appVersion: info.bundleVersion.slice(0, 40),
    lastError: lastError?.text,
    requestId: lastError?.requestId ?? lastRequestId ?? undefined,
    network: networkName(),
    platform: info.kind,
    nativeVersion: info.nativeVersion?.slice(0, 40) ?? undefined,
    device: info.kind === 'web' ? undefined : info.model?.slice(0, 80) ?? undefined,
  };
}

/** Что именно уйдёт специалисту — человек вправе увидеть это до отправки (разд. 50). */
export function describeContext(c: SupportContextInput): string[] {
  const out: string[] = [];
  if (c.route) out.push(`раздел: ${c.route}`);
  if (c.entityType) out.push(`${c.entityType === 'task' ? 'задача' : c.entityType === 'project' ? 'проект' : c.entityType}: ${c.entityId}`);
  if (c.platform === 'capacitor') out.push(`приложение${c.nativeVersion ? ` ${c.nativeVersion}` : ''}`);
  if (c.device) out.push(c.device);
  if (c.browser) out.push(c.browser);
  if (c.os) out.push(c.os);
  if (c.lastError) out.push('последняя ошибка на экране');
  return out;
}
