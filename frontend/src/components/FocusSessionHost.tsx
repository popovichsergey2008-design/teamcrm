import { useEffect } from 'react';
import { api } from '../lib/api';
import { setQuietSource } from '../lib/quiet';
import { getSocket } from '../lib/socket';
import { showNotification, showToast } from '../lib/notifications';
import { playKnock } from '../lib/sound';
import { lazyComponent } from '../lib/lazy';
import { refreshFocusSession, useFocusSession } from '../hooks/useFocusSession';

/*
  Окно глубокой работы — отдельным куском сборки: открывается только тогда, когда
  фокус действительно идёт.
*/
const FocusZen = lazyComponent(() => import('./FocusZen').then((m) => m.FocusZen));

/**
 * Глубокая работа на уровне приложения (ТЗ-16, волна 4).
 *
 * Здесь — всё, что должно работать на любом экране: узнать при входе, не идёт ли
 * фокус (перезагрузка его не сбрасывает), подхватить фокус, начатый на другом
 * устройстве, держать тишину и принять «постучать срочно» — единственное, что эту
 * тишину пробивает.
 */
export function FocusSessionHost({ onOpenTask }: { onOpenTask: (projectId: string, taskId: string) => void }) {
  const { session } = useFocusSession();

  // День закрыт с тихим режимом — молчим до утра; утром тишина снимается сама.
  useEffect(() => {
    let timer: number | null = null;
    const check = () => {
      api.focusWorkday().then((w) => {
        setQuietSource('workday', w.quiet);
        if (timer) window.clearTimeout(timer);
        if (w.quiet && w.closedUntil) {
          const ms = new Date(w.closedUntil).getTime() - Date.now();
          if (ms > 0 && ms < 2 ** 31 - 1) timer = window.setTimeout(() => setQuietSource('workday', false), ms);
        }
      }).catch(() => undefined);
    };
    check();
    const socket = getSocket();
    socket.on('workday.closed', check);
    return () => { socket.off('workday.closed', check); if (timer) window.clearTimeout(timer); };
  }, []);

  useEffect(() => {
    void refreshFocusSession();
    const socket = getSocket();
    const refresh = () => { void refreshFocusSession(); };
    const onKnock = (p: { fromName: string; reason: string | null }) => {
      const body = p.reason ? `«${p.reason}»` : 'Просит отвлечься — срочно';
      showToast({ title: `${p.fromName} стучит`, body, section: 'chat', critical: true });
      showNotification(`${p.fromName} стучит`, body, undefined, { critical: true });
      playKnock(true);
    };
    const events = ['focus.session.started', 'focus.session.paused', 'focus.session.resumed', 'focus.session.completed', 'connect'];
    events.forEach((e) => socket.on(e, refresh));
    socket.on('focus.knock', onKnock);
    return () => {
      events.forEach((e) => socket.off(e, refresh));
      socket.off('focus.knock', onKnock);
    };
  }, []);

  if (!session) return null;
  return <FocusZen session={session} onOpenTask={onOpenTask} />;
}
