import { useEffect } from 'react';
import { api } from '../lib/api';
import { showNotification, showToast } from '../lib/notifications';
import { getSocket } from '../lib/socket';
import { navigate, parsePath } from '../lib/router';
import { playMessageChime } from '../lib/sound';
import { platform, isNativeShell } from '../platform';

const CURSOR_KEY = 'teamcrm.inbox-cursor';
/** Оболочка сообщает о push, пришедшем при открытом приложении. */
export const PUSH_FOREGROUND_EVENT = 'teamcrm:push-foreground';

/**
 * Ящик уведомлений — правда, push — сигнал (ТЗ-9, волна 4).
 *
 * При старте, при возврате в приложение и по каждому push (в том числе пришедшему в
 * открытое приложение) телефон спрашивает сервер «что было после моей последней
 * записи». Так событие не теряется, даже если push не дошёл. Новое показываем
 * всплывашками (не больше трёх — остальное на значке), значок = непрочитанное.
 */
export function useMobileInbox(signedIn: boolean): void {
  useEffect(() => {
    if (!signedIn || !isNativeShell()) return;
    let alive = true;
    let busy = false;
    const sync = async () => {
      if (busy) return;
      busy = true;
      try {
        const cursor = localStorage.getItem(CURSOR_KEY);
        const r = await api.mobileNotifications(cursor);
        if (!alive) return;
        if (r.cursor) localStorage.setItem(CURSOR_KEY, r.cursor);
        platform.notifications.setBadge(r.unread);
        // без курсора это первый запуск: не заваливать человека всей историей
        const fresh = cursor ? r.items : [];
        for (const it of fresh.slice(-3)) {
          // приложение свёрнуто — всплывашку никто не увидит: в центр уведомлений ОС (волна 12)
          if (document.hidden) showNotification(it.title, it.body, () => openInboxItem(it.id, it.path ?? undefined));
          else showToast({ title: it.title, body: it.body, section: 'inbox', inboxPath: it.path ?? undefined, inboxId: it.id });
        }
        if (fresh.length) playMessageChime();
      } catch { /* нет сети — догоним в следующий раз */ }
      finally { busy = false; }
    };
    void sync();
    const onVisible = () => { if (document.visibilityState === 'visible') void sync(); };
    const onPush = () => { void sync(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(PUSH_FOREGROUND_EVENT, onPush);
    // Сервер положил запись в ящик — говорит об этом по сокету: пока процесс жив, push не нужен.
    const socket = getSocket();
    socket.on('inbox.item', onPush);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(PUSH_FOREGROUND_EVENT, onPush);
      socket.off('inbox.item', onPush);
    };
  }, [signedIn]);
}

/** Щелчок по уведомлению: отметить прочитанным до него и перейти. */
export function openInboxItem(id: string | undefined, path: string | undefined): void {
  if (id) void api.mobileNotificationsRead(id).catch(() => undefined);
  if (path) navigate(parsePath(path));
}