/**
 * Уведомления о новых сообщениях.
 *
 * Два уровня намеренно: счётчик в шапке и в заголовке вкладки работает ВСЕГДА
 * и ничего не спрашивает, а системные уведомления браузера — только если человек
 * сам их разрешил. Полагаться на второе нельзя: разрешение часто не дают, а в
 * некоторых браузерах и окружениях его вообще нет.
 */

const BASE_TITLE = 'TEAMCRM';

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
export interface ToastPayload { title: string; body: string; chatId?: string }
export function showToast(payload: ToastPayload): void {
  window.dispatchEvent(new CustomEvent<ToastPayload>(TOAST_EVENT, { detail: payload }));
}

/**
 * Короткий сигнал о новом сообщении.
 *
 * Синтезируем через WebAudio, а не проигрываем файл: звук в бандле — лишние
 * килобайты и запрос, который блокирует политика безопасности страницы.
 * Браузер не даст звучать до первого клика по странице — это нормально
 * и не считается ошибкой.
 */
let audioCtx: AudioContext | null = null;
export function playChime(): void {
  try {
    const Ctor = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!Ctor) return;
    audioCtx = audioCtx ?? new Ctor();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    const now = audioCtx.currentTime;
    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
    gain.connect(audioCtx.destination);
    // две ноты вверх: короткий «дилинь», не похожий на системный звук ошибки
    for (const [freq, at] of [[660, 0], [880, 0.09]] as const) {
      const osc = audioCtx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + at);
      osc.connect(gain);
      osc.start(now + at);
      osc.stop(now + at + 0.18);
    }
  } catch { /* звук — приятное дополнение, без него уведомление всё равно видно */ }
}

/** Счётчик в заголовке вкладки: видно, даже когда окно свёрнуто. */
export function setTitleUnread(count: number): void {
  document.title = count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
}

/** Изменения чатов, о которых стоит пересчитать непрочитанное (прочли, открыли, вышли). */
export const CHATS_CHANGED = 'teamcrm:chats-changed';
export function notifyChatsChanged(): void {
  window.dispatchEvent(new CustomEvent(CHATS_CHANGED));
}
