import { useEffect, useState } from 'react';
import { api, FocusSession } from '../lib/api';
import { setQuietSource } from '../lib/quiet';

/**
 * Идущая сессия глубокой работы — одна на приложение (ТЗ-16, волна 4).
 *
 * Её видят и «Фокус дня» (кнопка «Войти в глубокий фокус»), и окно таймера поверх
 * всего, поэтому состояние живёт здесь, а не в компоненте. Время — от сервера:
 * `remainingSeconds` пересчитывается в момент ответа с поправкой на часы устройства.
 */
type State = { session: FocusSession | null; loaded: boolean; receivedAt: number };
let state: State = { session: null, loaded: false, receivedAt: 0 };
const listeners = new Set<(s: State) => void>();

function publish(session: FocusSession | null) {
  state = { session, loaded: true, receivedAt: Date.now() };
  // идёт фокус — тишина; пауза — тоже: человек вышел ненадолго, не открывать шлюзы
  setQuietSource('session', !!session);
  listeners.forEach((l) => l(state));
}

export async function refreshFocusSession(): Promise<FocusSession | null> {
  try {
    const s = await api.focusSessionCurrent();
    publish(s);
    return s;
  } catch {
    if (!state.loaded) publish(null);
    return state.session;
  }
}

export function setFocusSession(s: FocusSession | null) {
  publish(s);
}

/** Сколько секунд осталось сейчас — по ответу сервера и прошедшему с него времени. */
export function remainingNow(s: FocusSession, receivedAt: number): number {
  if (s.status === 'paused') return s.remainingSeconds;
  return Math.max(0, s.remainingSeconds - Math.floor((Date.now() - receivedAt) / 1000));
}

export function useFocusSession(): State {
  const [s, setS] = useState<State>(state);
  useEffect(() => {
    listeners.add(setS);
    setS(state);
    return () => { listeners.delete(setS); };
  }, []);
  return s;
}

/*
  Длительность глубокого фокуса (#1568): выбирает человек — 20, 30, 50 минут и так далее.
  Запоминаем у него в браузере: кто работает отрезками по 30 минут, выбирает это один раз.
*/
export const FOCUS_MINUTES = [20, 30, 45, 50, 60, 90, 120];
const FOCUS_MINUTES_KEY = 'qevo.focusMinutes';
export function readFocusMinutes(): number {
  try {
    const v = Number(localStorage.getItem(FOCUS_MINUTES_KEY));
    return FOCUS_MINUTES.includes(v) ? v : 50;
  } catch { return 50; }
}
export function saveFocusMinutes(v: number): void {
  try { localStorage.setItem(FOCUS_MINUTES_KEY, String(v)); } catch { /* приватный режим — просто не запомним */ }
}
