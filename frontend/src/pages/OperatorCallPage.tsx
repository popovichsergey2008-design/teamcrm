import { useEffect, useState } from 'react';
import { CallPanel } from '../components/CallPanel';

interface Pass { token: string; iceServers: RTCIceServer[]; userId: string; roomId: string; name: string }

/** Пропуск лежит во фрагменте адреса (#…): на сервер он не уходит и в журналах nginx не оседает. */
function readPass(): Pass | null {
  try {
    const raw = window.location.hash.slice(1);
    if (!raw) return null;
    const json = decodeURIComponent(escape(atob(raw.replace(/-/g, '+').replace(/_/g, '/'))));
    const p = JSON.parse(json) as Pass;
    return p.token && p.roomId && p.userId ? p : null;
  } catch { return null; }
}

/**
 * Созвон оператора консоли поддержки (support.qevo.one → «Принять созвон»).
 *
 * У оператора нет учётки CRM: он входит пропуском в одну комнату, хозяином — и сам
 * впускает клиента, который стучится по гостевой ссылке из разговора.
 */
export default function OperatorCallPage() {
  const [pass] = useState(readPass);
  const [done, setDone] = useState(false);
  // пропуск из адресной строки убираем сразу: вкладку могут переслать или сохранить
  useEffect(() => { if (window.location.hash) window.history.replaceState(null, '', window.location.pathname); }, []);

  if (!pass || done) {
    return (
      <div className="guest-meet-page" style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: 16, textAlign: 'center' }}>
        <div>
          <h1 style={{ fontSize: 20 }}>{done ? 'Созвон завершён' : 'Пропуск в созвон не найден'}</h1>
          <p className="dim">{done ? 'Вкладку можно закрыть — итог созвона придёт в разговор.' : 'Откройте созвон заново из консоли поддержки.'}</p>
        </div>
      </div>
    );
  }
  return (
    <CallPanel
      meetingId={pass.roomId}
      guest={{ token: pass.token, iceServers: pass.iceServers, userId: pass.userId, host: true }}
      onClose={() => setDone(true)}
    />
  );
}
