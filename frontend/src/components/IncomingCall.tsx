import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { tokens } from '../lib/api';
import { startRingtone, stopRingtone } from '../lib/sound';

export interface Incoming {
  meetingId: string;
  callerName: string;
  callerId: string;
}

/**
 * Приём входящих звонков. Держит лёгкое соединение с сигналингом, пока человек
 * в системе: без него позвонить конкретному сотруднику невозможно — он просто
 * не узнает о звонке. В комнату это соединение не входит, только слушает.
 */
export function useIncomingCalls(enabled: boolean): { incoming: Incoming | null; accept: () => string | null; decline: () => void } {
  const [incoming, setIncoming] = useState<Incoming | null>(null);
  const ws = useRef<WebSocket | null>(null);
  // что показано прямо сейчас: обработчик сокета живёт в замыкании и состояния не видит,
  // а погасить нужно ИМЕННО тот звонок, который отменили, а не любой
  const shown = useRef<Incoming | null>(null);
  const show = (call: Incoming | null) => { shown.current = call; setIncoming(call); };

  useEffect(() => {
    if (!enabled || !tokens.access) return;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closed) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(`${proto}://${window.location.host}/ws/meet?token=${encodeURIComponent(tokens.access ?? '')}`);
      ws.current = socket;
      socket.onmessage = (e) => {
        let msg: any;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type === 'meet.incoming-call') {
          show({
            meetingId: String(msg.payload?.meeting_id),
            callerName: msg.payload?.caller_name ?? 'Коллега',
            callerId: msg.payload?.caller_id,
          });
          // звонок слышно, даже когда вкладка свёрнута: окно вызова человек попросту не увидит
          startRingtone();
        }
        // ответили с другого устройства — гасим окно здесь
        if (msg.type === 'meet.call-answered-elsewhere') { show(null); stopRingtone(); }
        // звонящий передумал и вышел: окно должно закрыться само, а не звенеть в пустоту
        if (msg.type === 'meet.call-cancelled' && shown.current?.meetingId === String(msg.payload?.meeting_id)) {
          show(null);
          stopRingtone();
        }
      };
      // сеть моргнула — переподключаемся, иначе звонки перестанут доходить молча
      socket.onclose = () => { if (!closed) retry = setTimeout(connect, 3000); };
    };
    connect();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws.current?.close();
      ws.current = null;
      stopRingtone(); // ушли со страницы или разлогинились — звонить некому
    };
  }, [enabled]);

  const accept = () => {
    const id = incoming?.meetingId ?? null;
    stopRingtone();
    show(null);
    return id;
  };
  const decline = () => {
    stopRingtone();
    if (incoming && ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({
        type: 'meet.decline',
        payload: { meeting_id: incoming.meetingId, caller_id: incoming.callerId },
      }));
    }
    show(null);
  };

  return { incoming, accept, decline };
}

export function IncomingCallDialog({ call, onAccept, onDecline }: {
  call: Incoming; onAccept: () => void; onDecline: () => void;
}) {
  return (
    <div className="incoming-call">
      <div className="incoming-title"><Icon name="phone" size={16} /> Звонит {call.callerName}</div>
      <div className="incoming-actions">
        <button className="btn btn-sm incoming-accept" onClick={onAccept}><Icon name="check" size={14} /> Принять</button>
        <button className="btn btn-sm incoming-decline" onClick={onDecline}><Icon name="close" size={14} /> Отклонить</button>
      </div>
    </div>
  );
}
