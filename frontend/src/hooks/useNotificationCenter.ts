import { useEffect } from 'react';
import { api } from '../lib/api';
import { getSocket } from '../lib/socket';
import { showNotification, showToast } from '../lib/notifications';
import { playMessageChime } from '../lib/sound';
import { openInboxItem } from './useMobileInbox';
import { setCenterUnread } from '../lib/notification-center';
import { isNativeShell } from '../platform';
import { quietFor } from '../lib/quiet';
import { inboxToastAllowed, loadInboxModes } from '../lib/inbox-api';

/**
 * Центр уведомлений (#4655): счётчик на значке живьём и всплывашка о событии по задаче.
 *
 * Сервер кладёт запись в историю и говорит об этом по сокету (`inbox.item`); прочтение
 * на любом устройстве — `inbox.read`. На оба пересчитываем число: оно одно на все
 * значки. Всплывашка — только в браузере: в приложении на телефоне её показывает
 * ящик оболочки (useMobileInbox), второй такой же не нужно. Щелчок по ней ведёт
 * к задаче, а погасшая всплывашка остаётся в центре непрочитанной строкой.
 *
 * #4691: по задачам было тихо — всплывашка без звука, а в свёрнутой вкладке ничего.
 * Теперь как в чатах: сигнал сообщения и, если вкладка не на виду, уведомление ОС.
 * Новая задача на мне звенит своим сигналом (useTabAlert, `task.for_you`) — здесь не дублируем.
 */
const OWN_CHIME = new Set(['task.created', 'task.assignee']);
/** Пачка событий (утренний обход сроков, комментарий + упоминание) звенит один раз. */
const CHIME_GAP_MS = 2_000;
/** Всплывашки, которые висят до прочтения. */
const STICKY_EVENTS = new Set(['task.auto_confirm', 'calendar.invite']);

export function useNotificationCenter(signedIn: boolean): void {
  useEffect(() => {
    if (!signedIn) { setCenterUnread(0); return; }
    let alive = true;
    let timer = 0;
    const load = () => {
      // события приходят пачкой (комментарий + упоминание) — спрашиваем один раз
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        api.notificationUnread().then((r) => { if (alive) setCenterUnread(r.unread); }).catch(() => undefined);
      }, 150);
    };
    load();
    loadInboxModes();
    const socket = getSocket();
    let lastChime = 0;
    const onItem = (p: { id?: string; eventKey?: string; title?: string; body?: string; path?: string; toast?: boolean }) => {
      load();
      if (!p?.toast || !p.title || isNativeShell()) return;
      /*
        #4807 §6.5, п. 4 и 6: в глубоком фокусе «Входящие» копятся без звука и без
        всплывашек (после — одна сводка); тип в режиме «Только входящие» — тоже тихо.
      */
      const key = p.eventKey ?? '';
      if (quietFor({ personal: key.endsWith('.mention') }) || !inboxToastAllowed(key)) return;
      if (document.hidden) showNotification(p.title, p.body ?? '', () => openInboxItem(p.id, p.path), { key: p.path });
      // не гаснут сами, пока не прочитают: «Задача поставлена от вас» ждёт «Ок/Править» (#4742),
      // приглашение на встречу — в том числе поставленную агентом из переписки (#4749)
      else showToast({ title: p.title, body: p.body ?? '', section: 'inbox', inboxId: p.id, inboxPath: p.path, sticky: STICKY_EVENTS.has(p.eventKey ?? '') });
      const now = Date.now();
      if (!OWN_CHIME.has(p.eventKey ?? '') && now - lastChime > CHIME_GAP_MS) {
        lastChime = now;
        playMessageChime();
      }
    };
    socket.on('inbox.item', onItem);
    socket.on('inbox.read', load);
    socket.on('connect', load);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      socket.off('inbox.item', onItem);
      socket.off('inbox.read', load);
      socket.off('connect', load);
    };
  }, [signedIn]);
}
