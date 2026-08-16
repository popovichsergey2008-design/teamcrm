import { useMemo, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { User } from '../types';

/**
 * Создание группового чата: название и состав.
 * Себя в список не выводим — автор попадает в группу всегда, выбирать это незачем.
 */
export function GroupChatModal({ users, meId, onClose, onCreated }: {
  users: User[];
  meId: string | undefined;
  onClose: () => void;
  onCreated: (chatId: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const candidates = useMemo(
    () => users.filter((u) => String(u.id) !== String(meId) && u.isActive !== false),
    [users, meId],
  );
  const shown = candidates.filter((u) => !query || u.fullName.toLowerCase().includes(query.toLowerCase()));
  const chosen = Object.keys(picked).filter((id) => picked[id]);

  const submit = async () => {
    if (!title.trim()) return setErr('Назовите группу');
    if (chosen.length === 0) return setErr('Добавьте хотя бы одного участника');
    setErr(''); setBusy(true);
    try {
      const chat = await api.createChatGroup(title.trim(), chosen);
      onCreated(chat.id);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось создать группу');
    } finally { setBusy(false); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head"><h3>Новая группа</h3><button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button></div>

        <div className="field"><label>Название</label>
          <input
            className="input" autoFocus placeholder="Например: Мануфактура — производство"
            value={title} onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          />
        </div>

        <div className="field">
          <label>Участники {chosen.length > 0 && <span className="dim">— выбрано {chosen.length}</span>}</label>
          {candidates.length > 6 && (
            <input className="input" placeholder="Поиск по имени" value={query} onChange={(e) => setQuery(e.target.value)} />
          )}
          <div className="group-members">
            {shown.length === 0 && <div className="muted" style={{ padding: 8 }}>Никого не найдено</div>}
            {shown.map((u) => (
              <label key={u.id} className="notify-row" style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={!!picked[u.id]}
                  onChange={(e) => setPicked((s) => ({ ...s, [u.id]: e.target.checked }))}
                />
                <span className="avatar-xs avatar-ph">{u.fullName[0]?.toUpperCase()}</span>
                <span>{u.fullName}</span>
              </label>
            ))}
          </div>
        </div>

        {err && <div className="error-text">{err}</div>}
        <button className="btn btn-primary" style={{ width: '100%', marginTop: 6 }} disabled={busy} onClick={submit}>
          {busy ? 'Создаём…' : 'Создать группу'}
        </button>
      </div>
    </div>
  );
}
