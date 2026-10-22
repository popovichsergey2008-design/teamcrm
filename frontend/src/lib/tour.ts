import { useEffect, useState } from 'react';
import { api } from './api';

/**
 * Обучение новичка (#4605): пошаговый показ с подсветкой, как в Яндекс.Вордстате.
 *
 * Здесь — только состояние и запуск, без показа: сам показ (components/tour) грузится
 * отдельным куском, и первый экран от него не тяжелеет.
 *
 * Что пройдено — у человека в ui_prefs.tour, а не в браузере: сел за другой компьютер
 * или открыл приложение на телефоне — обучение не начинается заново.
 * `auto: false` — сам не запускается (так помечены все, кто пришёл до обучения, и
 * кто нажал «Больше не показывать»); вручную — из меню профиля в любой момент.
 */
// #4632: подсказки и у остальных разделов меню — при первом заходе в каждый
export const TOUR_KEYS = ['intro', 'board', 'chats', 'focus', 'calendar', 'projects', 'news', 'pulse', 'support', 'settings', 'profile', 'secretary'] as const;
export type TourKey = (typeof TOUR_KEYS)[number];
export interface TourPrefs { auto?: boolean; done?: string[] }

const START = 'qevo:tour';
let prefs: TourPrefs = {};
let seededFor: string | null = null;

export function seedTour(userId: string | null | undefined, from: TourPrefs | undefined): void {
  if (!userId || seededFor === userId) return;
  seededFor = userId;
  prefs = { ...(from ?? {}) };
}

export const tourPrefs = (): TourPrefs => prefs;
export const tourDone = (key: TourKey): boolean => (prefs.done ?? []).includes(key);
/** Есть ли что показать самому — тогда и стоит грузить показ. */
export const tourPending = (): boolean => prefs.auto !== false && TOUR_KEYS.some((k) => !tourDone(k));

function save(next: TourPrefs) {
  prefs = next;
  void api.saveUiPrefs({ tour: next }).catch(() => undefined);
}

export function markTourDone(key: TourKey): void {
  if (tourDone(key)) return;
  save({ ...prefs, done: [...(prefs.done ?? []), key] });
}

/** «Больше не показывать»: сам больше не запустится, из меню — можно. */
export function stopTourAuto(): void {
  save({ ...prefs, auto: false });
}

/**
 * Пройти заново (меню профиля): общий обзор сейчас, а подсказки разделов —
 * снова при первом заходе в каждый.
 */
export function restartTour(): void {
  save({ auto: true, done: [] });
  // показ мог ещё не загрузиться — тогда он заберёт просьбу, как только появится
  manual = 'intro';
  window.dispatchEvent(new CustomEvent(START, { detail: 'intro' }));
}

let manual: TourKey | null = null;
/** Просьба показать обучение, пришедшая до загрузки показа. */
export function takeManualTour(): TourKey | null {
  const m = manual;
  manual = null;
  return m;
}

/** Нужен ли показ на экране: есть непройденное или его позвали вручную. */
export function useTourWanted(): boolean {
  const [wanted, setWanted] = useState(tourPending);
  useEffect(() => {
    const on = () => setWanted(true);
    window.addEventListener(START, on);
    return () => window.removeEventListener(START, on);
  }, []);
  return wanted || tourPending();
}

export const TOUR_START_EVENT = START;

/*
  Первый запуск (#4620): слайды, «Как запустим ваше рабочее пространство?», Qevo-бот.
  Один раз — у кого нет ui_prefs.welcome.done (старым людям его поставила миграция
  0197); заново — «Быстрый старт» в меню профиля. Сам показ — отдельным куском.
  0 — не показывать, иначе ключ показа: новый ключ — показ с начала.
*/
const WELCOME = 'qevo:welcome';
export const restartWelcome = () => window.dispatchEvent(new Event(WELCOME));
export function useWelcome(done?: boolean): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const on = () => setN((v) => v + 1);
    window.addEventListener(WELCOME, on);
    return () => window.removeEventListener(WELCOME, on);
  }, []);
  return n ? n + 1 : done ? 0 : 1;
}
