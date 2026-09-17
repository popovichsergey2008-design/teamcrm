import type { SupportContextInput } from '../types';

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

/** Запомнить ошибку. Зовётся из перехватчика ответов и из обработчика сбоев окна. */
export function noteSupportError(text: string, requestId?: string): void {
  const clean = String(text ?? '').trim().slice(0, 500);
  if (!clean) return;
  lastError = { text: clean, requestId };
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

export function collectSupportContext(): SupportContextInput {
  const ua = navigator.userAgent ?? '';
  const path = window.location.pathname;
  return {
    url: window.location.href.slice(0, 500),
    route: path.split('/').filter(Boolean)[0] || 'focus',
    ...entityFrom(path),
    browser: browserName(ua),
    os: osName(ua),
    appVersion: (import.meta as { env?: Record<string, string> }).env?.VITE_APP_VERSION ?? 'web',
    buildId: (import.meta as { env?: Record<string, string> }).env?.VITE_BUILD_ID ?? undefined,
    lastError: lastError?.text,
    requestId: lastError?.requestId,
    network: navigator.onLine === false ? 'offline' : 'online',
  };
}

/** Что именно уйдёт специалисту — человек вправе увидеть это до отправки (разд. 50). */
export function describeContext(c: SupportContextInput): string[] {
  const out: string[] = [];
  if (c.route) out.push(`раздел: ${c.route}`);
  if (c.entityType) out.push(`${c.entityType === 'task' ? 'задача' : c.entityType === 'project' ? 'проект' : c.entityType}: ${c.entityId}`);
  if (c.browser) out.push(c.browser);
  if (c.os) out.push(c.os);
  if (c.lastError) out.push('последняя ошибка на экране');
  return out;
}
