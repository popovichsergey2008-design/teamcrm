import { useCallback, useEffect, useState } from 'react';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { api, ApiError } from '../lib/api';
import type { User } from '../types';
import { overlayProps } from '../lib/overlay';

interface Member { userId: string; fullName: string }

/**
 * Управление группой: состав, название, выход.
 * Права разграничены на сервере — здесь лишь прячем то, что всё равно не сработает,
 * чтобы человек не жал кнопку и не получал отказ.
 */
export function GroupManageModal({ chatId, title, users, meId, onClose, onChanged, onLeft }: {
  chatId: string;
  title: string;
  users: User[];
  meId: string | undefined;
  onClose: () => void;
  onChanged: () => void;
  onLeft: () => void;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [name, setName] = useState(title);
  const [adding, setAdding] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.chatMembers(chatId);
      setMembers(data.members);
      setCanManage(data.canManage);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось загрузить состав'); }
  }, [chatId]);
  useEffect(() => { load(); }, [load]);

  const outside = users.filter(
    (u) => !members.some((m) => String(m.userId) === String(u.id)) && u.isActive !== false,
  );
  const chosen = Object.keys(adding).filter((id) => adding[id]);

  const wrap = async (fn: () => Promise<unknown>) => {
    setErr(''); setBusy(true);
    try { await fn(); await load(); onChanged(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
    finally { setBusy(false); }
  };

  const leave = async () => {
    if (!window.confirm('Выйти из группы? Переписка останется у остальных участников.')) return;
    setBusy(true);
    try { await api.leaveChat(chatId); onLeft(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось выйти'); setBusy(false); }
  };

  return (
    <div className="modal-overlay" {...overlayProps(onClose)}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head"><h3>Группа</h3><button className="btn btn-ghost btn-sm" onClick={onClose} title="Закрыть"><Icon name="close" /></button></div>

        <div className="field"><label>Название</label>
          <div className="team-rate">
            <input className="input" value={name} disabled={!canManage} onChange={(e) => setName(e.target.value)} />
            {canManage && (
              <button className="btn btn-sm" disabled={busy || !name.trim() || name.trim() === title}
                      onClick={() => wrap(() => api.renameChat(chatId, name.trim()))}>
                Сохранить
              </button>
            )}
          </div>
        </div>

        <div className="drawer-section-title">Участники ({members.length})</div>
        <div className="group-members">
          {members.map((m) => (
            <div key={m.userId} className="notify-row">
              <Avatar path={(m as any).avatarUrl ?? null} fallback={m.fullName[0]?.toUpperCase() ?? '?'} className="avatar-sm" />
              <span style={{ flex: 1 }}>{m.fullName}{String(m.userId) === String(meId) && <span className="dim"> — вы</span>}</span>
              {canManage && String(m.userId) !== String(meId) && (
                <button className="btn btn-ghost btn-sm" title="Убрать из группы" disabled={busy}
                        onClick={() => wrap(() => api.removeChatMember(chatId, m.userId))}><Icon name="close" size={13} /></button>
              )}
            </div>
          ))}
        </div>

        {outside.length > 0 && (
          <>
            <div className="drawer-section-title">Добавить</div>
            <div className="group-members">
              {outside.map((u) => (
                <label key={u.id} className="notify-row" style={{ cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!adding[u.id]}
                         onChange={(e) => setAdding((s) => ({ ...s, [u.id]: e.target.checked }))} />
                  <Avatar path={(u as any).avatarUrl ?? null} fallback={u.fullName[0]?.toUpperCase() ?? '?'} className="avatar-sm" />
                  <span>{u.fullName}</span>
                </label>
              ))}
            </div>
            <button className="btn btn-sm" style={{ width: '100%', marginTop: 6 }} disabled={busy || chosen.length === 0}
                    onClick={() => wrap(async () => { await api.addChatMembers(chatId, chosen); setAdding({}); })}>
              Добавить выбранных ({chosen.length})
            </button>
          </>
        )}

        {err && <div className="error-text">{err}</div>}
        <button className="btn btn-ghost btn-sm group-leave" disabled={busy} onClick={leave}>
          Выйти из группы
        </button>
      </div>
    </div>
  );
}
