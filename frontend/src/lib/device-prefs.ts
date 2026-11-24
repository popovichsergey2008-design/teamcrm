import { platform } from '../platform';

/*
  Настройки этого устройства (браузера): разрешение на уведомления браузер даёт месту, а не
  человеку, поэтому и выбор хранится здесь же, в localStorage.
*/
const get = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } };

/**
 * #5021: спрашивать ли «Задачу уже изменили — какой вариант оставить?».
 * Выключено — при настоящем столкновении правок остаётся мой вариант, как в других CRM.
 */
const CONFLICT = 'qevo.conflict.ask';
export const askOnConflict = (): boolean => get(CONFLICT) !== 'off';
export const setAskOnConflict = (on: boolean) => set(CONFLICT, on ? 'on' : 'off');

/**
 * #5023: системные уведомления браузера о личных сообщениях — как в Slack: QEVO в другой
 * вкладке, вам написали в личку — всплывает уведомление. Только личка, иначе это спам.
 * Не выбирали — включено, если браузер уже разрешил уведомления.
 */
const DM_PUSH = 'qevo.push.dm';
const DM_ASKED = 'qevo.push.dm.asked';
export const dmPushOn = (): boolean => {
  const v = get(DM_PUSH);
  return v ? v === 'on' : platform.notifications.permission() === 'granted';
};
export const setDmPush = (on: boolean) => { set(DM_PUSH, on ? 'on' : 'off'); set(DM_ASKED, '1'); };
/** Предлагали ли уже включить (окно «Да / Нет» показываем один раз на устройстве). */
export const dmPushAsked = (): boolean => get(DM_ASKED) === '1' || get(DM_PUSH) !== null;

/** Включить: браузер спросит разрешение. false — запретили или браузер не умеет. */
export async function enableDmPush(): Promise<boolean> {
  const p = await platform.notifications.requestPermission();
  const ok = p === 'granted';
  setDmPush(ok);
  return ok;
}
