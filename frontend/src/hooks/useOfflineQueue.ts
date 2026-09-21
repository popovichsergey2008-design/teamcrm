import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, isNetworkError } from '../lib/api';
import {
  OFFLINE_QUEUE_EVENT, type Outcome, type QueuedChange, flushQueue, queuedFor, readQueue, summarize, type QueueSummary,
} from '../lib/offline-queue';

/** Очередь ушла (хоть что-то отправилось): экранам пора перечитать своё. */
export const OFFLINE_FLUSHED_EVENT = 'teamcrm:offline-flushed';

/** Исход одной записи по ответу сервера. */
function outcomeOf(e: unknown): Outcome {
  if (isNetworkError(e)) return { kind: 'retry' };
  if (e instanceof ApiError && e.code === 'CONFLICT') {
    const d = (e.details ?? {}) as { reason?: string; task?: Record<string, unknown>; fields?: string[] };
    if (d.reason === 'version' && d.task) return { kind: 'conflict', error: e.message, current: d.task, fields: d.fields ?? [] };
  }
  // сессия кончилась — не «провал записи»: она уйдёт после входа
  if (e instanceof ApiError && (e.code === 'UNAUTHORIZED' || e.code === 'SESSION_REVOKED')) return { kind: 'retry' };
  return { kind: 'failed', error: e instanceof ApiError ? e.message : 'Не отправилось' };
}

/** Прогнать очередь; общий для хука и для кнопки «Повторить». */
export async function flushOffline(): Promise<boolean> {
  const sent = await flushQueue(async (c: QueuedChange) => {
    try { await api.replay(c); return { kind: 'sent' }; } catch (e) { return outcomeOf(e); }
  });
  if (sent) {
    window.dispatchEvent(new Event(OFFLINE_FLUSHED_EVENT));
    window.dispatchEvent(new Event('teamcrm:tasks-changed'));
  }
  return sent;
}

/**
 * Офлайн-очередь как состояние приложения (ТЗ-9, волна 9).
 *
 * Следит за сетью и за очередью: вернулась сеть, вернулись в приложение, прошла
 * полминуты с отложенными записями — пробуем отправить. Наружу отдаёт сводку для
 * полосы «Нет сети · N изменений ожидают» и сам список для панели очереди.
 */
export function useOfflineQueue(signedIn: boolean): {
  online: boolean;
  items: QueuedChange[];
  summary: QueueSummary;
  flush: () => Promise<boolean>;
} {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const [items, setItems] = useState<QueuedChange[]>(() => readQueue());

  useEffect(() => {
    const onQueue = () => setItems(readQueue());
    const onOnline = () => { setOnline(true); if (signedIn) void flushOffline(); };
    const onOffline = () => setOnline(false);
    const onVisible = () => { if (document.visibilityState === 'visible' && navigator.onLine && signedIn) void flushOffline(); };
    window.addEventListener(OFFLINE_QUEUE_EVENT, onQueue);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisible);
    if (signedIn && navigator.onLine) void flushOffline();
    // «online» в WebView срабатывает не всегда: раз в полминуты пробуем сами, пока есть что слать
    const timer = window.setInterval(() => {
      if (signedIn && navigator.onLine && readQueue().some((c) => c.status === 'pending')) void flushOffline();
    }, 30_000);
    return () => {
      window.removeEventListener(OFFLINE_QUEUE_EVENT, onQueue);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
    };
  }, [signedIn]);

  const flush = useCallback(() => flushOffline(), []);
  return { online, items, summary: summarize(items), flush };
}

/** Записи очереди для одного места — ленты задачи или чата: показать их «ожидает сети» на месте. */
export function useQueuedFor(path: string | null): QueuedChange[] {
  const [items, setItems] = useState<QueuedChange[]>(() => (path ? queuedFor(path) : []));
  useEffect(() => {
    if (!path) { setItems([]); return; }
    const read = () => setItems(queuedFor(path));
    read();
    window.addEventListener(OFFLINE_QUEUE_EVENT, read);
    return () => window.removeEventListener(OFFLINE_QUEUE_EVENT, read);
  }, [path]);
  return items;
}
