/**
 * Уведомления о новых сообщениях.
 *
 * Два уровня намеренно: счётчик в шапке и в заголовке вкладки работает ВСЕГДА
 * и ничего не спрашивает, а системные уведомления браузера — только если человек
 * сам их разрешил. Полагаться на второе нельзя: разрешение часто не дают, а в
 * некоторых браузерах и окружениях его вообще нет.
 */

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  return notificationsSupported() ? Notification.permission : 'unsupported';
}

/** Разрешение запрашиваем только по явному действию: непрошеный запрос браузеры глушат. */
export async function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!notificationsSupported()) return 'unsupported';
  try { return await Notification.requestPermission(); } catch { return Notification.permission; }
}

/** Показ уведомления. Молча ничего не делает, если разрешения нет. */
export function showNotification(title: string, body: string, onClick?: () => void): void {
  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag: 'teamcrm-chat', renotify: true } as NotificationOptions);
    n.onclick = () => { window.focus(); n.close(); onClick?.(); };
  } catch { /* некоторые браузеры запрещают конструктор вне service worker */ }
}

/**
 * Всплывающее уведомление внутри приложения.
 *
 * Системные уведомления браузера работают только с разрешения, а его обычно
 * не дают — и человек не узнавал о сообщении вовсе. Это работает всегда,
 * пока вкладка открыта. Слушатель живёт в App.
 */
export const TOAST_EVENT = 'teamcrm:toast';
export interface ToastPayload {
  title: string;
  body: string;
  chatId?: string;
  /** Куда ведёт щелчок. По умолчанию — в чаты: с них уведомления и начинались. */
  section?: 'chat' | 'feed' | 'focus' | 'meetings';
  /**
   * `saved` — короткий ответ на действие человека: «сохранено», «отправлено».
   * Такая всплывашка никуда не ведёт и живёт вдвое меньше: она отвечает на вопрос
   * «получилось?», а не зовёт куда-то идти.
   */
  kind?: 'info' | 'saved';
}
export function showToast(payload: ToastPayload): void {
  window.dispatchEvent(new CustomEvent<ToastPayload>(TOAST_EVENT, { detail: payload }));
}

/**
 * «Сохранено» — один и тот же ответ на любое сохранение в системе.
 *
 * Заказчик: «везде где нажимаем сохранить должно быть какое-то оповещение».
 * Половина форм молчала: человек жал кнопку, ничего не менялось на экране, и он
 * жал ещё раз. Одна функция на всё приложение — чтобы ответ был одинаковый и не
 * пришлось в каждой форме придумывать свой.
 */
export function toastSaved(title = 'Сохранено', body = ''): void {
  showToast({ title, body, kind: 'saved' });
}

/*
  Счётчик в заголовке вкладки живёт в `tab-alert`: там же мигание о новом, и два
  хозяина у `document.title` неизбежно перетирали бы друг друга. Здесь — только
  повторный вывоз, чтобы места вызова не переписывать.
*/
export { setTitleUnread } from './tab-alert';

/** Изменения чатов, о которых стоит пересчитать непрочитанное (прочли, открыли, вышли). */
export const CHATS_CHANGED = 'teamcrm:chats-changed';
export function notifyChatsChanged(): void {
  window.dispatchEvent(new CustomEvent(CHATS_CHANGED));
}
