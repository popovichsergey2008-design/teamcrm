import { useEffect, useRef } from 'react';
import { getSocket } from '../lib/socket';

/**
 * Страховка чатов поверх сокета (#4634).
 *
 * Сокет переподключается сам и на 'connect' переписка догружается, но пока его
 * нет — события идут мимо. Поэтому: пока связи нет, раз в 15 с перечитываем
 * открытое; вкладка вернулась из фона после паузы — тоже. Функцию догрузки
 * страница кладёт в возвращённую ссылку.
 */
export function useChatResync() {
  const resync = useRef<(() => void) | null>(null);
  useEffect(() => {
    const socket = getSocket();
    const run = () => resync.current?.();
    const t = window.setInterval(() => { if (!socket.connected && !document.hidden) run(); }, 15_000);
    let hiddenAt = 0;
    const onVisible = () => {
      if (document.hidden) { hiddenAt = Date.now(); return; }
      if (!socket.connected || Date.now() - hiddenAt > 10_000) run();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, []);
  return resync;
}
