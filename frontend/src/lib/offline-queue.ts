/**
 * Очередь изменений без сети (ТЗ-9, волна 9).
 *
 * Телефон в метро: человек пишет комментарий, правит описание задачи — и не должен
 * видеть «Сообщение не отправлено». Изменение ложится в очередь и уходит само, когда
 * сеть вернётся. Каждая запись несёт свой uuid — он же `Idempotency-Key` на сервере,
 * поэтому повторная отправка после обрыва не плодит дубли.
 *
 * Очередь — в localStorage: переживает закрытие приложения, живёт на одном устройстве.
 * Порядок отправки — порядок постановки: второй комментарий не должен обогнать первый.
 * Столкнулись с чужой правкой (409 по версии) — запись остаётся с пометкой `conflict`,
 * решает человек. Отвергнуто сервером по существу (400/404) — `failed`, человек видит
 * и убирает сам: молча выбрасывать написанное нельзя.
 *
 * Чистые функции внизу (`applyOutcome`, `summarize`) проверяет logic-check.
 */

export type QueuedStatus = 'pending' | 'failed' | 'conflict';

export interface QueuedChange {
  /** uuid — и ключ идемпотентности на сервере. */
  id: string;
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  /** Версия задачи, на которую делалась правка: сервер сверит через If-Match. */
  ifMatch?: number | null;
  /** Что это, человеческим языком: «Комментарий к задаче #12». */
  label: string;
  /** Короткий текст для показа в очереди (первые слова сообщения). */
  preview?: string;
  createdAt: string;
  status: QueuedStatus;
  error?: string;
  /** Текущее состояние на сервере при конфликте версий — чтобы показать оба варианта. */
  conflict?: { current: Record<string, unknown>; fields: string[] } | null;
}

export type Outcome =
  | { kind: 'sent' }
  | { kind: 'retry' }
  | { kind: 'failed'; error: string }
  | { kind: 'conflict'; error: string; current: Record<string, unknown>; fields: string[] };

const KEY = 'teamcrm.offline-queue';
const MAX = 200;
export const OFFLINE_QUEUE_EVENT = 'teamcrm:offline-queue';

function safeStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export function readQueue(): QueuedChange[] {
  try {
    const raw = safeStorage()?.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as QueuedChange[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function writeQueue(items: QueuedChange[]): void {
  try { safeStorage()?.setItem(KEY, JSON.stringify(items.slice(-MAX))); } catch { /* нет места — очередь не критична */ }
  try { window.dispatchEvent(new Event(OFFLINE_QUEUE_EVENT)); } catch { /* вне браузера */ }
}

export function newChangeId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  } catch { /* старый WebView */ }
  return `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function enqueue(change: Omit<QueuedChange, 'createdAt' | 'status'>): QueuedChange {
  const item: QueuedChange = { ...change, createdAt: new Date().toISOString(), status: 'pending' };
  writeQueue([...readQueue().filter((c) => c.id !== item.id), item]);
  return item;
}

/**
 * Правка столкнулась с чужой сразу, при живой сети (409 по версии): кладём её в очередь
 * уже с пометкой `conflict`, чтобы человек разобрал два варианта тем же листом, что и
 * после офлайна. Пока он решает, написанное не потеряно.
 */
export function enqueueConflict(
  change: Omit<QueuedChange, 'createdAt' | 'status' | 'conflict'>,
  current: Record<string, unknown>,
  fields: string[],
): QueuedChange {
  const item: QueuedChange = {
    ...change, createdAt: new Date().toISOString(), status: 'conflict',
    error: 'Задачу уже изменили', conflict: { current, fields },
  };
  writeQueue([...readQueue().filter((c) => c.id !== item.id), item]);
  return item;
}

export function removeQueued(id: string): void {
  writeQueue(readQueue().filter((c) => c.id !== id));
}

/** Повторить: сбросить ошибку; при конфликте — пойти поверх новой версии. */
export function retryQueued(id: string, ifMatch?: number | null): void {
  writeQueue(readQueue().map((c) => (c.id === id
    ? { ...c, status: 'pending' as const, error: undefined, conflict: null, ifMatch: ifMatch === undefined ? c.ifMatch : ifMatch }
    : c)));
}

/** Записи очереди для одного места (ленты задачи, чата): показать «ожидает сети» на месте. */
export function queuedFor(path: string): QueuedChange[] {
  return readQueue().filter((c) => c.path === path);
}

/**
 * Что делать с очередью после ответа сервера на одну запись. Чистая функция.
 * `retry` (нет сети) — ничего не меняем и обход останавливается снаружи.
 */
export function applyOutcome(items: QueuedChange[], id: string, outcome: Outcome): QueuedChange[] {
  if (outcome.kind === 'sent') return items.filter((c) => c.id !== id);
  if (outcome.kind === 'retry') return items;
  return items.map((c) => {
    if (c.id !== id) return c;
    if (outcome.kind === 'failed') return { ...c, status: 'failed', error: outcome.error, conflict: null };
    return { ...c, status: 'conflict', error: outcome.error, conflict: { current: outcome.current, fields: outcome.fields } };
  });
}

export interface QueueSummary { pending: number; failed: number; conflict: number; total: number }

export function summarize(items: QueuedChange[]): QueueSummary {
  const s: QueueSummary = { pending: 0, failed: 0, conflict: 0, total: items.length };
  for (const c of items) s[c.status] += 1;
  return s;
}

/** Строка для полосы состояния: что показать человеку про очередь. Чистая. */
export function queueBanner(online: boolean, s: QueueSummary): string | null {
  const n = s.pending;
  const word = n % 10 === 1 && n % 100 !== 11 ? 'изменение' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'изменения' : 'изменений';
  const waits = n % 10 === 1 && n % 100 !== 11 ? 'ожидает' : 'ожидают';
  if (!online) return n ? `Нет сети · ${n} ${word} ${waits} отправки` : 'Нет сети · изменения сохранятся и отправятся позже';
  if (s.conflict) return `Есть изменения, столкнувшиеся с чужими: ${s.conflict}`;
  if (s.failed) return `Не отправилось: ${s.failed}`;
  if (n) return `Отправляем ${n} ${word}…`;
  return null;
}

let flushing: Promise<boolean> | null = null;

/**
 * Прогнать очередь: по порядку, до первого «нет сети».
 * `send` возвращает исход одной записи. Возвращает true, если хоть что-то ушло.
 */
export function flushQueue(send: (c: QueuedChange) => Promise<Outcome>): Promise<boolean> {
  if (flushing) return flushing;
  flushing = (async () => {
    let sentAny = false;
    for (const c of readQueue()) {
      if (c.status !== 'pending') continue;
      const outcome = await send(c);
      if (outcome.kind === 'retry') break;
      if (outcome.kind === 'sent') sentAny = true;
      // перечитываем: пока запись уходила, человек мог поставить в очередь ещё одну
      writeQueue(applyOutcome(readQueue(), c.id, outcome));
    }
    return sentAny;
  })().finally(() => { flushing = null; });
  return flushing;
}
