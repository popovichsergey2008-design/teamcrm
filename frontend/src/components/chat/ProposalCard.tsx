import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { ApiError, request } from '../../lib/api';
import { getSocket } from '../../lib/socket';
import { navigate } from '../../lib/router';
import './proposal.css';

interface Proposal {
  id: string; chatId: string; status: 'open' | 'scheduled' | 'cancelled'; topic: string | null; minutes: number; isAuthor: boolean;
  members: { id: string; name: string; voted: boolean }[];
  slots: { index: number; startsAt: string; endsAt: string; label: string; votes: number; mine: boolean }[];
  event: { id: string; title: string; label: string; agenda: string | null } | null;
}

/**
 * Встреча прямо из чата (#4892, п. 5): QEVO AI предложил три слота, участники
 * голосуют кнопками — видно число голосов. Ответили все или автор нажал «Назначить» —
 * встреча создаётся, и в чат приходит подтверждение со ссылкой в календарь.
 */
export default function ProposalCard({ id, body }: { id: string; body: string }) {
  const [p, setP] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const load = useCallback(() => request<Proposal>('GET', `/calendar/plus/proposals/${id}`).then(setP).catch(() => undefined), [id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const s = getSocket();
    const on = (e: { proposalId?: string }) => { if (String(e?.proposalId) === id) void load(); };
    s.on('chat.proposal', on);
    return () => { s.off('chat.proposal', on); };
  }, [id, load]);

  const act = async (path: string, index: number) => {
    setBusy(true); setErr('');
    try { setP(await request<Proposal>('POST', `/calendar/plus/proposals/${id}/${path}`, { index })); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
    finally { setBusy(false); }
  };

  const confirm = body.startsWith('✓');
  const openCalendar = () => { if (p?.event) navigate({ section: 'calendar' }); };

  if (confirm) {
    const [head, ...rest] = body.split('\n');
    return (
      <div className="prop-card prop-done">
        <div><b>✓ Встреча назначена:</b> {head.replace(/^✓\s*Встреча назначена:\s*/, '')}</div>
        <div className="prop-sub">
          {rest.join(' ')}{p?.event && <> · <button type="button" className="prop-link" onClick={openCalendar}>открыть в календаре</button></>}
        </div>
      </div>
    );
  }

  const voted = p?.members.filter((m) => m.voted).length ?? 0;
  return (
    <div className="prop-card">
      <div className="prop-head"><span className="prop-badge">QEVO AI</span> {p ? `Похоже на встречу. Свободны ${p.members.length === 2 ? 'оба' : p.members.length === 3 ? 'все трое' : `все ${p.members.length}`}:` : body}</div>
      {p && (
        <>
          <div className="prop-slots">
            {p.slots.map((s) => (
              <button key={s.index} type="button" className={`prop-slot${s.mine ? ' mine' : ''}`} disabled={busy || p.status !== 'open'}
                onClick={() => void act('vote', s.index)} title={s.mine ? 'Снять голос' : 'Мне подходит'}>
                {s.label}{s.votes ? ` · ${s.votes} ✓` : ''}
              </button>
            ))}
          </div>
          <div className="prop-sub">
            Участники из чата · {p.minutes} мин · ссылка на звонок будет создана · ответили {voted} из {p.members.length}
            {p.status === 'scheduled' && ' · встреча назначена'}
          </div>
          {p.isAuthor && p.status === 'open' && (
            <div className="prop-actions">
              <span className="prop-sub">Назначить сейчас:</span>
              {p.slots.map((s) => (
                <button key={s.index} type="button" className="ui-btn ui-btn-outline ui-btn-sm" disabled={busy} onClick={() => void act('schedule', s.index)}>{s.label}</button>
              ))}
              <button type="button" className="prop-link" onClick={() => void request('POST', '/calendar/plus/proposals/mute', { chatId: p.chatId }).then(() => setErr('Больше не предложу в этом чате. Вызвать вручную — /встреча'))}>
                не предлагать в этом чате
              </button>
            </div>
          )}
        </>
      )}
      {err && <div className="prop-sub"><Icon name="info" size={12} /> {err}</div>}
    </div>
  );
}
