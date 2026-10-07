import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { getSocket } from '../lib/socket';
import { showNotification } from '../lib/notifications';
import { playKnock, playMessageChime } from '../lib/sound';

interface HostCall {
  kind: 'waiting' | 'soon';
  linkId: string;
  roomId: string;
  label: string | null;
  guestName: string | null;
  title: string;
  body: string;
}

/**
 * «Гость ждёт в созвоне» и «скоро встреча с гостем — откройте комнату».
 *
 * Впустить гостя может только сотрудник, который уже сидит в комнате, а стук слышат
 * лишь те, кто внутри. Поэтому сервер зовёт автора ссылки сам, и зов должен дожить
 * до ответа: всплывашка гаснет через шесть секунд, а гость за дверью ждёт дольше.
 * Карточка висит, пока не нажали «Войти» или «Позже».
 */
export function useGuestHostCalls(enabled: boolean): { call: HostCall | null; dismiss: () => void } {
  const [call, setCall] = useState<HostCall | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const socket = getSocket();
    const on = (p: HostCall) => {
      setCall(p);
      // ждущий гость — стук, как в комнате; напоминание заранее — обычный сигнал
      if (p.kind === 'waiting') playKnock(); else playMessageChime();
      showNotification(p.title, p.body);
    };
    socket.on('meet.guest-call-host', on);
    return () => { socket.off('meet.guest-call-host', on); };
  }, [enabled]);

  return { call, dismiss: () => setCall(null) };
}

export function GuestHostCallCard({ call, onJoin, onDismiss }: {
  call: HostCall;
  onJoin: (roomId: string) => void;
  onDismiss: () => void;
}) {
  return (
    <div className={`guest-host-call ${call.kind === 'waiting' ? 'is-waiting' : ''}`} role="alert">
      <Icon name={call.kind === 'waiting' ? 'bell' : 'calendar'} size={20} />
      <div className="guest-host-call-text">
        <div className="guest-host-call-title">{call.title}</div>
        <div className="dim">{call.body}</div>
      </div>
      <div className="guest-host-call-actions">
        <button className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => { onJoin(call.roomId); onDismiss(); }} autoFocus>
          <Icon name="phone" size={14} /> Войти
        </button>
        <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={onDismiss}>Позже</button>
      </div>
    </div>
  );
}
