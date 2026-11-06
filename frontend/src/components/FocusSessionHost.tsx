import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import { Icon } from './Icon';
import { api } from '../lib/api';
import { setQuietSource } from '../lib/quiet';
import { getSocket } from '../lib/socket';
import { showNotification } from '../lib/notifications';
import { navigate } from '../lib/router';
import { playKnock } from '../lib/sound';
import { lazyComponent } from '../lib/lazy';
import { refreshFocusSession, setFocusSession, useFocusSession } from '../hooks/useFocusSession';

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
  /** Запланированный в календаре фокус наступил (#4787, п. 12) — предложить начать. */
  const [due, setDue] = useState<{ minutes: number; taskIds: string[] } | null>(null);
  /** #4782, п. 5: срочное обращение — один заметный сигнал и выбор «Ответить» / «Продолжить фокус». */
  const [urgent, setUrgent] = useState<{ fromUserId: string; fromName: string; reason: string | null } | null>(null);
  useEffect(() => {
    const socket = getSocket();
    const onDue = (p: { minutes: number; taskIds: string[] }) => setDue({ minutes: p.minutes, taskIds: p.taskIds ?? [] });
    socket.on('focus.block.due', onDue);
    return () => { socket.off('focus.block.due', onDue); };
  }, []);

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
    const onKnock = (p: { fromUserId: string; fromName: string; reason: string | null }) => {
      const body = p.reason ? `«${p.reason}»` : 'Просит отвлечься — срочно';
      setUrgent({ fromUserId: String(p.fromUserId), fromName: p.fromName, reason: p.reason });
      // окно со свёрнутой вкладкой не видно — системное уведомление, и то одно
      if (document.hidden) showNotification(`${p.fromName}: срочно`, body, undefined, { critical: true });
      playKnock(true);
    };
    const events = ['focus.session.started', 'focus.session.paused', 'focus.session.resumed', 'focus.session.completed', 'focus.session.ended', 'connect'];
    events.forEach((e) => socket.on(e, refresh));
    socket.on('focus.knock', onKnock);
    return () => {
      events.forEach((e) => socket.off(e, refresh));
      socket.off('focus.knock', onKnock);
    };
  }, []);

  const urgentBox = urgent && (
    <div role="alertdialog" aria-label="Срочное обращение" style={{
      position: 'fixed', left: '50%', top: 24, transform: 'translateX(-50%)', zIndex: 80, display: 'flex', flexDirection: 'column', gap: 8,
      width: 'min(440px, calc(100vw - 32px))', padding: '14px 16px', borderRadius: 12, border: '2px solid var(--warn)',
      background: 'var(--bg-elev)', color: 'var(--text)', boxShadow: '0 12px 32px rgba(0,0,0,.25)',
    }}>
      <b><Icon name="hand" size={16} /> {urgent.fromName}: срочно</b>
      <span>{urgent.reason ? `«${urgent.reason}»` : 'Просит отвлечься'}</span>
      <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button size="sm" variant="primary" onClick={() => {
          const u = urgent;
          setUrgent(null);
          void api.openDm(u.fromUserId).then((dm) => navigate({ section: 'chat', chatId: String(dm.id) })).catch(() => undefined);
        }}>Ответить</Button>
        <Button size="sm" variant="ghost" onClick={() => setUrgent(null)}>Продолжить фокус</Button>
      </span>
    </div>
  );

  if (!session) {
    if (!due) return urgentBox || null;
    return (
      // стиль — здесь же: плашка живёт в первом экране, а стили фокуса грузятся только с его окном
      <div role="alertdialog" aria-label="Время глубокого фокуса" style={{
        position: 'fixed', right: 16, bottom: 16, zIndex: 60, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8,
        maxWidth: 'min(460px, calc(100vw - 32px))', padding: '10px 14px', borderRadius: 12, border: '1px solid var(--accent)',
        background: 'var(--bg-elev)', color: 'var(--text)', boxShadow: '0 8px 24px rgba(0,0,0,.18)',
      }}>
        <Icon name="target" size={18} />
        <span>Время глубокого фокуса: {due.minutes} мин{due.taskIds.length ? ` · ${due.taskIds.map((id) => `№${id}`).join(', ')}` : ''}</span>
        <Button size="sm" variant="primary" onClick={() => {
          const d = due;
          setDue(null);
          void api.focusStart({ taskIds: d.taskIds, minutes: d.minutes }).then(setFocusSession).catch(() => undefined);
        }}>Начать</Button>
        <Button size="sm" variant="ghost" onClick={() => setDue(null)}>Позже</Button>
      </div>
    );
  }
  return <>{urgentBox}<FocusZen session={session} onOpenTask={onOpenTask} /></>;
}
