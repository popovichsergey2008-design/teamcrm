import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

export type NavCounters = {
  focus: { decide: number; today: number };
  radar: { risks: number } | null;
};

const EMPTY: NavCounters = { focus: { decide: 0, today: 0 }, radar: null };
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
    const soon = () => load();
    // своё действие обязано отражаться сразу: принял задачу — бейдж упал
    window.addEventListener('teamcrm:tasks-changed', soon);
    window.addEventListener('focus', soon);
    return () => {
      clearInterval(timer);
      window.removeEventListener('teamcrm:tasks-changed', soon);
      window.removeEventListener('focus', soon);
    };
  }, [enabled, load]);

  return counters;
}
