import { tokens } from './api';

/**
 * Отправка событий браузера в диагностический журнал.
 *
 * Половина картины созвона живёт только здесь: состояние ICE, приём дорожек,
 * отказы устройств, порядок сообщений сигналинга. По серверным логам этого
 * не восстановить — там видно лишь то, что до сервера дошло.
 *
 * Копим пачкой и отправляем раз в несколько секунд: на активном созвоне событий
 * десятки, и запрос на каждое сам стал бы помехой связи.
 */

interface Pending {
  scope: 'meet' | 'chat';
  refId?: string;
  event: string;
  data?: unknown;
  at: string;
}

const FLUSH_MS = 4000;
const MAX_BUFFER = 150;

let buffer: Pending[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

async function flush(useBeacon = false): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null; }
  const events = buffer;
  buffer = [];
  if (!events.length || !tokens.access) return;

  const body = JSON.stringify({ events });
  // Уход со страницы: обычный запрос браузер отменит, маячок — доставит.
  // Именно последние события перед закрытием обычно и объясняют поломку.
  if (useBeacon && navigator.sendBeacon) {
    const ok = navigator.sendBeacon('/api/diag/events', new Blob([body], { type: 'application/json' }));
    if (ok) return;
  }
  try {
    await fetch('/api/diag/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.access}` },
      body,
      keepalive: true,
    });
  } catch { /* журнал не важнее того, что им измеряют */ }
}

/** Записать событие. Никогда не бросает и не ждёт сети. */
export function diag(scope: 'meet' | 'chat', event: string, refId?: string, data?: unknown): void {
  buffer.push({ scope, refId, event, data, at: new Date().toISOString() });
  // защита от лавины: при шторме событий сохраняем последние, а не первые
  if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
  if (!timer) timer = setTimeout(() => void flush(), FLUSH_MS);
}

/** Досрочная отправка — на выходе из созвона, чтобы не терять концовку. */
export function flushDiag(): void {
  void flush(true);
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => flush(true));
}
