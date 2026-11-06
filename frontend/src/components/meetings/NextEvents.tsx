import { useState } from 'react';
import { Icon } from '../Icon';
import { Button } from '../ui/button';
import { request, ApiError } from '../../lib/api';
import { navigate } from '../../lib/router';

export interface NextEvent {
  id: string; title: string; startsAt: string; endsAt: string; status: 'pending' | 'accepted' | 'dismissed';
  eventId: string | null; quote: string | null; people: string[];
}

const when = (iso: string) => new Date(iso).toLocaleString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

/**
 * Следующая встреча (#4779, п. 5): на созвоне договорились встретиться снова — ИИ
 * предлагает событие с датой и участниками. «Добавить в календарь» ставит его в календарь
 * QEVO и Google Календарь участников; за 10 минут им придёт напоминание.
 */
export function NextEvents({ meetingId, items, onChange }: { meetingId: string; items: NextEvent[]; onChange: (v: NextEvent[]) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const shown = items.filter((i) => i.status !== 'dismissed');
  if (!shown.length) return null;
  const act = async (id: string, what: 'accept' | 'dismiss') => {
    setBusy(id); setErr('');
    try { onChange(await request<NextEvent[]>('POST', `/meetings/${meetingId}/postcall/next-events/${id}/${what}`, {})); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
    finally { setBusy(null); }
  };
  return (
    <section className="pc-block">
      <h2 className="pc-block-title">Следующая встреча</h2>
      <ul className="pc-list">
        {shown.map((e) => (
          <li key={e.id}>
            <div><b>{e.title}</b> · {when(e.startsAt)}</div>
            {e.people.length > 0 && <div className="dim">Участники: {e.people.join(', ')}</div>}
            {e.quote && <div className="dim">«{e.quote}»</div>}
            <div className="pc-actions" style={{ marginTop: 6 }}>
              {e.status === 'accepted' ? (
                <>
                  <span className="pnl-good"><Icon name="check" size={14} /> В календаре — напоминание за 10 минут</span>
                  <Button variant="ghost" size="sm" onClick={() => navigate({ section: 'calendar' })}>Открыть календарь</Button>
                </>
              ) : (
                <>
                  <Button variant="primary" size="sm" disabled={busy === e.id} onClick={() => void act(e.id, 'accept')}>
                    <Icon name="calendar" size={14} /> Добавить в календарь
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy === e.id} onClick={() => void act(e.id, 'dismiss')}>Не нужно</Button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
      {err && <p className="error-text" role="alert">{err}</p>}
    </section>
  );
}
