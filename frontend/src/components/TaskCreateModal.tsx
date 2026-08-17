import { useState } from 'react';
import { Icon } from './Icon';
import { api, ApiError } from '../lib/api';
import type { User } from '../types';

interface Props {
  projectId: string;
  columnId: string;
  columnName: string;
  users: User[];
  defaultManagerId?: string;
  onClose: () => void;
  onCreated: () => void;
}

/** Форма создания задачи: название, исполнитель, руководитель, описание. */
export function TaskCreateModal({ projectId, columnId, columnName, users, defaultManagerId, onClose, onCreated }: Props) {
  const [title, setTitle] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [managerId, setManagerId] = useState(defaultManagerId ?? '');
  const [description, setDescription] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!title.trim()) return setErr('Введите название задачи');
    setErr('');
    setBusy(true);
    try {
      await api.createTask({
        projectId,
        columnId,
        title: title.trim(),
        description: description.trim() || undefined,
        assigneeId: assigneeId || undefined,
        managerId: managerId || undefined,
      });
      onCreated();
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось создать задачу');
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3>Новая задача · {columnName}</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose} title="Закрыть"><Icon name="close" /></button>
        </div>

        <div className="field"><label>Название</label>
          <input
            className="input"
            autoFocus
            value={title}
            placeholder="Что нужно сделать"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(); }}
          />
        </div>

        <div className="drawer-grid2">
          <div className="field"><label>Исполнитель</label>
            <select className="input" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">— не назначен —</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
            </select>
          </div>
          <div className="field"><label>Руководитель</label>
            <select className="input" value={managerId} onChange={(e) => setManagerId(e.target.value)}>
              <option value="">— не задан —</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
            </select>
          </div>
        </div>

        <div className="field"><label>Описание (необязательно)</label>
          <textarea className="input" rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>

        {err && <div className="error-text">{err}</div>}
        <button className="btn btn-primary" style={{ width: '100%', marginTop: 6 }} disabled={busy} onClick={submit}>
          {busy ? 'Создаём…' : 'Создать задачу'}
        </button>
      </div>
    </div>
  );
}
