import { useSyncExternalStore } from 'react';

/**
 * Центр уведомлений (#4655): число непрочитанного на значке — одно на всё приложение.
 *
 * Значков два-три (в левой панели, на телефоне сверху, в панели чатов справа), а
 * счётчик один: иначе каждый спрашивал бы сервер сам, и после «Прочитать все» один
 * гас бы, а другой продолжал гореть. Хранится здесь, наполняет его useNotificationCenter.
 */
let unread = 0;
const subs = new Set<() => void>();

export function setCenterUnread(n: number): void {
  const next = Math.max(0, Number(n) || 0);
  if (next === unread) return;
  unread = next;
  subs.forEach((fn) => fn());
}

export function useCenterUnread(): number {
  return useSyncExternalStore(
    (fn) => { subs.add(fn); return () => { subs.delete(fn); }; },
    () => unread,
  );
}

/** «99+» — как на счётчиках чатов: больше двух цифр на значке не помещается. */
export function badgeText(n: number): string {
  return n > 99 ? '99+' : String(n);
}

/** Открыть центр из любого места — событием: панель живёт в App, звать её через пропсы незачем. */
export const OPEN_CENTER_EVENT = 'teamcrm:open-notifications';
export function openNotificationCenter(): void {
  window.dispatchEvent(new CustomEvent(OPEN_CENTER_EVENT));
}
