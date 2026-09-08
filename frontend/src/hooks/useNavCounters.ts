import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

export type NavCounters = {
  focus: { decide: number; today: number };
  /** приглашения на встречи без ответа */
  calendar?: { pending: number };
  radar: { risks: number } | null;
  /** Новое в моих задачах: чужие изменения, которых я ещё не видел. */
  tasks?: { unread: number };
};

const EMPTY: NavCounters = { focus: { decide: 0, today: 0 }, calendar: { pending: 0 }, radar: null, tasks: { unread: 0 } };
/** Чаще этого за счётчиками не ходим: перещёлкивание разделов не должно долбить сервер. */
const MIN_INTERVAL_MS = 10_000;
const POLL_MS = 60_000;

/**
 * Счётчики бейджей левой панели.
 *
 * Обновляются от четырёх поводов: смена раздела, возврат во вкладку, свои изменения
 * задач (событие из api) и раз в минуту — чужие изменения приходят только так.
 * Постоянного WS-канала ради трёх чисел не заводим: панель и без того всегда на экране.
 */
export function useNavCounters(enabled: boolean, section: string): NavCounters {
  const [counters, setCounters] = useState<NavCounters>(EMPTY);
  const lastAt = useRef(0);

  const load = useCallback((force = false) => {
    if (!enabled) return;
    const now = Date.now();
    if (!force && now - lastAt.current < MIN_INTERVAL_MS) return;
    lastAt.current = now;
    api.navCounters().then(setCounters).catch(() => undefined); // молча: бейдж — не повод для ошибки на весь экран
  }, [enabled]);

  useEffect(() => { load(); }, [load, section]);

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => load(true), POLL_MS);
    // Своё действие обязано отражаться СРАЗУ: открыл задачу — цифра упала. Раньше
    // здесь стоял обычный `load()`, и его глушила защита «не чаще раза в десять
    // секунд» — человек читал задачу, а бейдж гас только через страницу.
    const now = () => load(true);
    const soon = () => load();
    window.addEventListener('teamcrm:tasks-changed', now);
    window.addEventListener('focus', soon);
    return () => {
      clearInterval(timer);
      window.removeEventListener('teamcrm:tasks-changed', now);
      window.removeEventListener('focus', soon);
    };
  }, [enabled, load]);

  return counters;
}
