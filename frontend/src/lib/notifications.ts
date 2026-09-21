import { platform } from '../platform';

/**
 * Уведомления о новых сообщениях.
 *
 * Два уровня намеренно: счётчик в шапке и в заголовке вкладки работает ВСЕГДА
 * и ничего не спрашивает, а системные уведомления браузера — только если человек
 * сам их разрешил. Полагаться на второе нельзя: разрешение часто не дают, а в
 * некоторых браузерах и окружениях его вообще нет.
 */

/*
  Системные уведомления ходят через мост платформы (ТЗ-9): в браузере — Notification
  API, в оболочке — центр уведомлений ОС. Имена функций прежние, чтобы места вызова
  не переписывать.
*/
export function notificationsSupported(): boolean {
  return platform.notifications.permission() !== 'unsupported';
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  return platform.notifications.permission();
}

/** Разрешение запрашиваем только по явному действию: непрошеный запрос браузеры глушат. */
export function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  return platform.notifications.requestPermission();
}

/** Показ уведомления. Молча ничего не делает, если разрешения нет. */
export function showNotification(title: string, body: string, onClick?: () => void): void {
  platform.notifications.show(title, body, onClick);
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
  section?: 'chat' | 'feed' | 'focus' | 'meetings' | 'support';
  /** Обращение службы заботы, которое откроет щелчок (для `section: 'support'`). */
  conversationId?: string;
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

/**
 * Просьба поднять созвон — из любого места, где открыта карточка задачи.
 *
 * Событием, а не свойством: карточку открывают доска, реестр задач, фокус дня и
 * поиск — тянуть обработчик звонка через все эти экраны значит протащить его через
 * половину приложения ради одной кнопки. Слушает его App, где созвон и живёт.
 */
export const START_CALL_EVENT = 'teamcrm:start-call';

export interface StartCallRequest {
  /** Кого зовём. */
  memberIds: string[];
  projectId?: string | null;
  /** Задача, из которой звонят: туда вернётся итог разговора. */
  taskId?: string | null;
  /** Видеозвонок — камера включается сразу; иначе только голос. */
  video?: boolean;
  title?: string;
  /**
   * Уже поднятая комната — войти в неё, а не создавать новую.
   *
   * Служба заботы поднимает комнату сама (на неё же выписана гостевая ссылка
   * клиенту); без этого поля оболочка создавала вторую, и стороны оказывались в
   * разных комнатах: клиент по ссылке в одной, специалист — в другой.
   */
  roomId?: string;
}

export function requestCall(req: StartCallRequest): void {
  window.dispatchEvent(new CustomEvent<StartCallRequest>(START_CALL_EVENT, { detail: req }));
}
