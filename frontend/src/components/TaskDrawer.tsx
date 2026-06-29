import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { Task, User } from '../types';

interface Props {
  task: Task;
  users: User[];
  timerActive: boolean;
  onToggleTimer: (taskId: string) => void;
  onClose: () => void;
  onRefresh: () => void;
}

const toLocalInput = (iso?: string | null) => (iso ? new Date(iso).toISOString().slice(0, 16) : '');

export function TaskDrawer({ task, users, timerActive, onToggleTimer, onClose, onRefresh }: Props) {
  const [assigneeId, setAssigneeId] = useState(task.assignee_id ?? '');
  const [estimate, setEstimate] = useState(task.estimate_hours ?? '');
  const [deadline, setDeadline] = useState(toLocalInput(task.deadline_at));
  const [warn, setWarn] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const userName = (id?: string | null) => users.find((u) => u.id === id)?.fullName ?? '—';

  const assign = async (confirmOverload: boolean) => {
    if (!assigneeId) {
      setErr('Выберите исполнителя');
      return;
    }
    setErr('');
    setBusy(true);
    try {
      const res = await api.assignTask(task.id, {
        assigneeId,
        confirmOverload,
        estimateHours: estimate ? Number(estimate) : undefined,
        deadlineAt: deadline ? new Date(deadline).toISOString() : undefined,
      });
      if (res.warning && !confirmOverload) {
        setWarn(res);
      } else {
        setWarn(null);
        onRefresh();
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Ошибка назначения');
    } finally {
      setBusy(false);
    }
  };

  const toggleBlocked = async () => {
    try {
      await api.updateTask(task.id, { isBlocked: !task.is_blocked });
      onRefresh();
    } catch {
      /* ignore */
    }
  };

  const cost = task.cost_current !== undefined ? Number(task.cost_current) : null;
  const riskColor = task.risk_level === 'red' ? 'pnl-bad' : task.risk_level === 'green' ? 'pnl-good' : '';

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3>{task.title}</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>

        {task.description && <p className="dim drawer-desc">{task.description}</p>}

        <div className="drawer-row">
          <span className="badge badge-role">{task.status}</span>
          {task.is_blocked && <span className="badge badge-blocked">BLOCKED</span>}
          {cost !== null && <span className="badge" title="Себестоимость (Этап 2)">₽ {cost.toLocaleString('ru-RU')}</span>}
        </div>

        {/* Таймер (Этап 2) */}
        <button
          className={`btn btn-sm drawer-timer ${timerActive ? 'timer-on' : ''}`}
          onClick={() => onToggleTimer(task.id)}
        >
          {timerActive ? '⏸ Пауза' : '▶ В работу'}
        </button>

        {/* Назначение + оценка/дедлайн (Этап 4) */}
        <div className="drawer-section">
          <div className="drawer-section-title">Назначение и план</div>
          <div className="field">
            <label>Исполнитель</label>
            <select className="input" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">— не назначен —</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.fullName} ({u.role})</option>
              ))}
            </select>
          </div>
          <div className="drawer-grid2">
            <div className="field">
              <label>Оценка, ч</label>
              <input className="input" type="number" min="0" step="0.5" value={estimate} onChange={(e) => setEstimate(e.target.value)} />
            </div>
            <div className="field">
              <label>Дедлайн</label>
              <input className="input" type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
            </div>
          </div>

          {warn && (
            <div className="overload-warn">
              ⚠ Перегруз: риск {warn.riskPct ?? '—'}%, прогноз нагрузки {warn.projectedHours}ч &gt; ёмкости {warn.capacityHours}ч/нед.
              <button className="btn btn-sm overload-confirm" disabled={busy} onClick={() => assign(true)}>
                Всё равно назначить
              </button>
            </div>
          )}
          {err && <div className="error-text">{err}</div>}
          <button className="btn btn-primary drawer-assign" disabled={busy} onClick={() => assign(false)}>
            {busy ? '...' : 'Назначить'}
          </button>
        </div>

        {/* Прогноз / светофор (Этап 4) */}
        <div className="drawer-section">
          <div className="drawer-section-title">Прогноз срока</div>
          <div className="drawer-row">
            {task.risk_level && <span className={`risk-dot risk-${task.risk_level}`} />}
            <span className={riskColor}>
              {task.risk_level ? `риск ${task.risk_pct ?? '—'}% (${task.risk_level})` : 'нет прогноза'}
            </span>
          </div>
          {task.predicted_finish_at && (
            <div className="dim">Прогноз завершения: {new Date(task.predicted_finish_at).toLocaleString('ru-RU')}</div>
          )}
          {task.assignee_id && <div className="dim">Текущий исполнитель: {userName(task.assignee_id)}</div>}
        </div>

        <button className="btn btn-ghost btn-sm" onClick={toggleBlocked}>
          {task.is_blocked ? 'Снять блокер' : 'Отметить BLOCKED'}
        </button>
      </aside>
    </div>
  );
}
