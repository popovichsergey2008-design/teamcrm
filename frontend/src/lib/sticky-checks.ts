import { useCallback, useState } from 'react';
import { api } from './api';
import { useAuth } from '../state/auth';

/**
 * Галочки, которые запоминают выбор человека (просьба заказчика).
 *
 * Раньше «Также отправить в основной чат», «требует согласования», «показывать задачи
 * в календаре» и подобные каждый раз начинались с заводского значения, и человек снова
 * и снова ставил (или снимал) одно и то же. Теперь его последний выбор становится его
 * значением по умолчанию — в следующих сессиях и на других устройствах.
 *
 * Хранится в личных настройках на сервере (`ui_prefs.checks`) и копией в браузере:
 * копия даёт значение мгновенно и без сети, сервер — переносит его на телефон.
 *
 * Только для настроек ВВОДА. Галочки, которые сами являются данными (пункт чек-листа,
 * выбранные участники, правила компании), сюда не относятся — у них своё хранение.
 */
const LS_PREFIX = 'teamcrm.checks.';
const SAVE_DELAY_MS = 700;

let cache: Record<string, boolean> = {};
let cacheFor = '';
let saveTimer: number | undefined;

function lsKey(userId: string) { return `${LS_PREFIX}${userId}`; }

function seed(userId: string, server: Record<string, unknown> | undefined) {
  if (cacheFor === userId) return;
  cacheFor = userId;
  let local: Record<string, boolean> = {};
  try { local = JSON.parse(localStorage.getItem(lsKey(userId)) || '{}'); } catch { /* приватный режим */ }
  // серверное главнее: оно общее для всех устройств человека
  cache = { ...local };
  for (const [k, v] of Object.entries(server ?? {})) if (typeof v === 'boolean') cache[k] = v;
}

function persist(userId: string) {
  try { localStorage.setItem(lsKey(userId), JSON.stringify(cache)); } catch { /* не страшно */ }
  window.clearTimeout(saveTimer);
  // пачкой и с задержкой: щёлкают по галочке туда-обратно, а сохранить нужно итог
  saveTimer = window.setTimeout(() => {
    void api.saveUiPrefs({ checks: { ...cache } }).catch(() => undefined);
  }, SAVE_DELAY_MS);
}

/**
 * Галочка с памятью: `[значение, установить]`. `fallback` — заводское значение,
 * пока человек ни разу не менял эту галочку сам.
 */
export function useStickyCheck(key: string, fallback: boolean): [boolean, (next: boolean) => void] {
  const { user } = useAuth();
  const userId = String(user?.id ?? '');
  if (userId) seed(userId, user?.uiPrefs?.checks);
  const [value, setValue] = useState<boolean>(() => (key in cache ? cache[key] : fallback));
  const set = useCallback((next: boolean) => {
    setValue(next);
    if (!userId) return;
    cache[key] = next;
    persist(userId);
  }, [key, userId]);
  return [value, set];
}

/** Подгрузить запомненное сразу при входе: формы, открытые первыми, должны видеть привычку. */
export function useSeedStickyChecks(): void {
  const { user } = useAuth();
  if (user?.id) seed(String(user.id), user.uiPrefs?.checks);
}

/** Прочитать запомненное без подписки — для мест, где значение нужно один раз. */
export function stickyCheck(key: string, fallback: boolean): boolean {
  return key in cache ? cache[key] : fallback;
}

/** Запомнить выбор без хука (когда галочка живёт в чужом состоянии, например в черновике). */
export function rememberCheck(userId: string, key: string, next: boolean): void {
  if (!userId) return;
  if (cacheFor !== userId) seed(userId, undefined);
  cache[key] = next;
  persist(userId);
}
