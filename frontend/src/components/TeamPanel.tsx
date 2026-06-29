import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { User } from '../types';

export function TeamPanel({ onClose }: { onClose: () => void }) {
  const [users, setUsers] = useState<User[]>([]);
  const [rate, setRate] = useState<Record<string, string>>({});
  const [metrics, setMetrics] = useState<Record<string, any>>({});
  const [msg, setMsg] = useState('');
  const [nu, setNu] = useState({ email: '', fullName: '', password: '' });

  const reload = () => api.listUsers().then(setUsers).catch(() => undefined);
  useEffect(() => { reload(); }, []);

  const addUser = async () => {
    if (!nu.email || !nu.fullName || nu.password.length < 8) {
      setMsg('Заполните email, имя и пароль (≥8)');
      return;
    }
    try {
      await api.createUser({ ...nu, role: 'member' });
      setNu({ email: '', fullName: '', password: '' });
      setMsg('Сотрудник добавлен');
      reload();
      setTimeout(() => setMsg(''), 2000);
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'Ошибка');
    }
  };

  const saveRate = async (userId: string) => {
    const v = Number(rate[userId]);
    if (!v || v <= 0) return;
    try {
      await api.createRate({ userId, hourlyRate: v });
      setMsg(`Ставка сохранена`);
      setTimeout(() => setMsg(''), 2000);
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'Ошибка');
    }
  };

  const loadMetrics = async (userId: string) => {
    const [v, l] = await Promise.all([api.getVelocity(userId), api.getLoad(userId)]);
    setMetrics((m) => ({ ...m, [userId]: { v, l } }));
  };

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3>Команда · ставки и метрики</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>
        {msg && <div className="dim">{msg}</div>}

        <div className="drawer-section" style={{ borderTop: 'none', marginTop: 0, paddingTop: 0 }}>
          <div className="drawer-section-title">Добавить сотрудника</div>
          <input className="input add-user-input" placeholder="Имя" value={nu.fullName} onChange={(e) => setNu({ ...nu, fullName: e.target.value })} />
          <input className="input add-user-input" placeholder="E-mail" value={nu.email} onChange={(e) => setNu({ ...nu, email: e.target.value })} />
          <input className="input add-user-input" type="password" placeholder="Пароль (≥8)" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} />
          <button className="btn btn-primary btn-sm" style={{ width: '100%' }} onClick={addUser}>Добавить</button>
        </div>

        {users.map((u) => (
          <div key={u.id} className="team-row">
            <div className="team-head">
              <span>{u.fullName}</span>
              <span className="badge badge-role">{u.role}</span>
            </div>
            <div className="team-rate">
              <input
                className="input"
                type="number"
                placeholder="₽/час"
                value={rate[u.id] ?? ''}
                onChange={(e) => setRate((r) => ({ ...r, [u.id]: e.target.value }))}
              />
              <button className="btn btn-sm" onClick={() => saveRate(u.id)}>Ставка</button>
              <button className="btn btn-ghost btn-sm" onClick={() => loadMetrics(u.id)}>Метрики</button>
            </div>
            {metrics[u.id] && (
              <div className="dim team-metrics">
                Velocity: {Number(metrics[u.id].v.velocity).toFixed(3)} зад/ч · закрыто {metrics[u.id].v.closedTasks} ·
                загрузка {metrics[u.id].l.queueHours}ч / ёмкость {metrics[u.id].l.effectiveCapacityHours}ч
                {metrics[u.id].l.utilizationPct !== null && ` (${metrics[u.id].l.utilizationPct}%)`}
              </div>
            )}
          </div>
        ))}
      </aside>
    </div>
  );
}
