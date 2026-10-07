import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { Button } from './ui/button';
import { promptText } from './ui/dialog';
import { api, ApiError, TeamPresence } from '../lib/api';
import { getSocket } from '../lib/socket';
import { toastSaved } from '../lib/notifications';

const hm = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/**
 * «Умный щит» в личной переписке (ТЗ-16, п. 53): собеседник в глубоком фокусе —
 * над полем ввода честно сказано, что сообщение придёт без звука, и есть «Постучать
 * срочно» для того, что правда не ждёт. Писать это не мешает.
 */
export function DeepFocusGuard({ peerId, peerName }: { peerId: string; peerName: string }) {
  const [p, setP] = useState<TeamPresence | null>(null);
  const [knocked, setKnocked] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setKnocked(false);
    api.teamPulseOne(peerId).then((r) => { if (alive) setP(r); }).catch(() => undefined);
    const socket = getSocket();
    const onUpdate = (u: TeamPresence) => { if (String(u.userId) === String(peerId)) setP(u); };
    socket.on('presence.updated', onUpdate);
    return () => { alive = false; socket.off('presence.updated', onUpdate); };
  }, [peerId]);

  if (!p || p.status !== 'deep_focus') return null;
  const first = peerName.split(' ')[0] || peerName;

  const knock = async () => {
    const reason = await promptText({
      title: `Постучать: ${first}`,
      description: 'Стук пробивает тишину фокуса. Он один на весь фокус — по-настоящему срочное.',
      placeholder: 'Что случилось (можно пусто)',
      confirmLabel: 'Постучать',
      singleLine: true,
    });
    if (reason === null) return;
    setBusy(true);
    try {
      await api.knock(peerId, reason || undefined);
      setKnocked(true);
      toastSaved('Постучали', `${first} увидит это сразу`);
    } catch (e) {
      toastSaved('Не получилось', e instanceof ApiError ? e.message : 'Попробуйте ещё раз');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tv2-callout" role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '0 0 8px' }}>
      <Icon name="target" size={15} />
      <span style={{ flex: 1, minWidth: 200 }}>
        {first} сейчас в глубоком фокусе{p.until ? ` до ${hm(p.until)}` : ''}. Сообщение будет доставлено без звука.
      </span>
      {knocked
        ? <span className="dim">Вы постучали</span>
        : <Button variant="outline" size="sm" disabled={busy} onClick={() => void knock()}><Icon name="hand" size={14} /> Постучать срочно</Button>}
    </div>
  );
}
