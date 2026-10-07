import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { Button } from './ui/button';
import { api, ApiError, ClientRow } from '../lib/api';
import { navigate } from '../lib/router';

/**
 * «Клиент» в карточке задачи (ТЗ-17, п. 33): видно, про какого клиента задача, и одним
 * нажатием — в его карточку. Привязать можно и задачу внутреннего проекта.
 */
export function TaskClientField({ taskId, clientId, onChanged }: { taskId: string; clientId: string | null; onChanged: () => void }) {
  const [name, setName] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<ClientRow[]>([]);
  const [err, setErr] = useState('');

  useEffect(() => {
    setName(null);
    if (clientId) api.clientBrief(clientId).then((c) => setName(c.name)).catch(() => setName('клиент недоступен'));
  }, [clientId]);

  useEffect(() => {
    if (!editing) return;
    const t = window.setTimeout(() => {
      api.clients(new URLSearchParams({ view: 'all', ...(q.trim() ? { q: q.trim() } : {}) }).toString())
        .then((r) => setFound(r.items.slice(0, 8))).catch(() => setFound([]));
    }, 250);
    return () => window.clearTimeout(t);
  }, [q, editing]);

  const set = async (id: string | null) => {
    setErr('');
    try { await api.updateTask(taskId, { clientId: id }); setEditing(false); setQ(''); onChanged(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось сохранить'); }
  };

  if (editing) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <input className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Найти клиента…" aria-label="Найти клиента" />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {found.map((c) => (
            <Button key={c.id} variant="ghost" size="sm" onClick={() => void set(c.id)}><Icon name={c.type === 'person' ? 'user' : 'building'} size={13} /> {c.name}</Button>
          ))}
          {clientId && <Button variant="ghost" size="sm" onClick={() => void set(null)}>Убрать клиента</Button>}
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>Отмена</Button>
        </div>
        {err && <div className="error-text">{err}</div>}
      </div>
    );
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
      {clientId ? (
        <Button variant="ghost" size="sm" onClick={() => navigate({ section: 'clients', clientId })} title="Открыть карточку клиента">
          <Icon name="building" size={13} /> {name ?? '…'}
        </Button>
      ) : <span className="ui-cell-dim">не указан</span>}
      <Button variant="ghost" size="sm" onClick={() => setEditing(true)} aria-label="Изменить клиента"><Icon name="edit" size={12} /></Button>
    </span>
  );
}
