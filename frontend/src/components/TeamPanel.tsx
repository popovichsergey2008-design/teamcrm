import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';

type Tab = 'people' | 'positions' | 'groups';
const ROLES = ['owner', 'manager', 'member'];

export function TeamPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('people');
  const [users, setUsers] = useState<any[]>([]);
  const [positions, setPositions] = useState<any[]>([]);
  const [groups, setGroups] = useState<any[]>([]);
  const [rate, setRate] = useState<Record<string, string>>({});
  const [metrics, setMetrics] = useState<Record<string, any>>({});
  const [msg, setMsg] = useState('');
  const [invite, setInvite] = useState<{ email: string; link: string } | null>(null);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 2500); };
  const reload = async () => {
    setUsers(await api.listUsers().catch(() => []));
    setPositions(await api.listPositions().catch(() => []));
    setGroups(await api.listGroups().catch(() => []));
  };
  useEffect(() => { reload(); }, []);

  // --- people ---
  const [nu, setNu] = useState({ email: '', fullName: '', password: '', role: 'member', positionId: '' });
  const addUser = async () => {
    if (!nu.email || !nu.fullName || nu.password.length < 8) return flash('Заполните email, имя, пароль (≥8)');
    try {
      await api.createUser({ ...nu, positionId: nu.positionId || undefined });
      setNu({ email: '', fullName: '', password: '', role: 'member', positionId: '' });
      flash('Сотрудник создан'); reload();
    } catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); }
  };
  const patchUser = async (id: string, patch: any) => {
    try { await api.updateUser(id, patch); reload(); }
    catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); }
  };
  const saveRate = async (userId: string) => {
    const v = Number(rate[userId]); if (!v || v <= 0) return;
    try { await api.createRate({ userId, hourlyRate: v }); flash('Ставка сохранена'); } catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); }
  };
  const loadMetrics = async (userId: string) => {
    const [v, l] = await Promise.all([api.getVelocity(userId), api.getLoad(userId)]);
    setMetrics((m) => ({ ...m, [userId]: { v, l } }));
  };

  // --- invite ---
  const [inv, setInv] = useState({ email: '', role: 'member', positionId: '' });
  const sendInvite = async () => {
    if (!inv.email) return flash('Укажите email');
    try {
      const r = await api.createInvite({ email: inv.email, role: inv.role, positionId: inv.positionId || undefined });
      setInvite({ email: r.email, link: `${window.location.origin}/?invite=${r.token}` });
      setInv({ email: '', role: 'member', positionId: '' });
    } catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); }
  };

  // --- positions ---
  const [newPos, setNewPos] = useState('');
  const addPos = async () => { if (!newPos.trim()) return; try { await api.createPosition(newPos.trim()); setNewPos(''); reload(); } catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); } };

  // --- groups ---
  const [newGroup, setNewGroup] = useState({ name: '', kind: 'group' });
  const addGroup = async () => { if (!newGroup.name.trim()) return; try { await api.createGroup({ name: newGroup.name.trim(), kind: newGroup.kind }); setNewGroup({ name: '', kind: 'group' }); reload(); } catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); } };
  const [memberPick, setMemberPick] = useState<Record<string, string>>({});

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head"><h3>Команда</h3><button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button></div>
        <div className="tabs">
          <button className={`tab ${tab === 'people' ? 'active' : ''}`} onClick={() => setTab('people')}>Сотрудники</button>
          <button className={`tab ${tab === 'positions' ? 'active' : ''}`} onClick={() => setTab('positions')}>Должности</button>
          <button className={`tab ${tab === 'groups' ? 'active' : ''}`} onClick={() => setTab('groups')}>Группы</button>
        </div>
        {msg && <div className="dim">{msg}</div>}

        {tab === 'people' && (
          <>
            <div className="drawer-section-title">Пригласить по ссылке</div>
            <div className="add-user">
              <input className="input add-user-input" placeholder="E-mail" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} />
              <div className="drawer-grid2">
                <select className="input" value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select>
                <select className="input" value={inv.positionId} onChange={(e) => setInv({ ...inv, positionId: e.target.value })}><option value="">— должность —</option>{positions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
              </div>
              <button className="btn btn-sm" onClick={sendInvite}>Создать ссылку-приглашение</button>
              {invite && (
                <div className="invite-box">
                  Ссылка для {invite.email}:
                  <input className="input" readOnly value={invite.link} onFocus={(e) => e.currentTarget.select()} />
                </div>
              )}
            </div>

            <div className="drawer-section-title">Создать сразу</div>
            <div className="add-user">
              <input className="input add-user-input" placeholder="Имя" value={nu.fullName} onChange={(e) => setNu({ ...nu, fullName: e.target.value })} />
              <input className="input add-user-input" placeholder="E-mail" value={nu.email} onChange={(e) => setNu({ ...nu, email: e.target.value })} />
              <input className="input add-user-input" type="password" placeholder="Пароль (≥8)" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} />
              <div className="drawer-grid2">
                <select className="input" value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select>
                <select className="input" value={nu.positionId} onChange={(e) => setNu({ ...nu, positionId: e.target.value })}><option value="">— должность —</option>{positions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
              </div>
              <button className="btn btn-primary btn-sm" style={{ width: '100%' }} onClick={addUser}>Добавить сотрудника</button>
            </div>

            <div className="drawer-section-title">Сотрудники ({users.length})</div>
            {users.map((u) => (
              <div key={u.id} className={`team-row ${u.isActive ? '' : 'team-inactive'}`}>
                <div className="team-head">
                  <span>{u.fullName} {!u.isActive && <span className="badge">неактивен</span>}</span>
                  <span className="dim">{u.positionName ?? '—'}</span>
                </div>
                <div className="drawer-grid2">
                  <select className="input" value={u.role} onChange={(e) => patchUser(u.id, { role: e.target.value })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select>
                  <select className="input" value={u.positionId ?? ''} onChange={(e) => patchUser(u.id, { positionId: e.target.value || null })}><option value="">— должность —</option>{positions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
                </div>
                {u.groups?.length > 0 && <div className="dim" style={{ marginTop: 6 }}>Группы: {u.groups.map((g: any) => g.name).join(', ')}</div>}
                <div className="team-rate">
                  <input className="input" type="number" placeholder="₽/час" value={rate[u.id] ?? ''} onChange={(e) => setRate((r) => ({ ...r, [u.id]: e.target.value }))} />
                  <button className="btn btn-sm" onClick={() => saveRate(u.id)}>Ставка</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => loadMetrics(u.id)}>Метрики</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => patchUser(u.id, { isActive: !u.isActive })}>{u.isActive ? 'Деактив.' : 'Вкл.'}</button>
                </div>
                {metrics[u.id] && (
                  <div className="dim team-metrics">
                    Velocity {Number(metrics[u.id].v.velocity).toFixed(3)} · закрыто {metrics[u.id].v.closedTasks} · загрузка {metrics[u.id].l.queueHours}ч / {metrics[u.id].l.effectiveCapacityHours}ч
                  </div>
                )}
              </div>
            ))}
          </>
        )}

        {tab === 'positions' && (
          <>
            <div className="team-rate" style={{ marginBottom: 12 }}>
              <input className="input" placeholder="Новая должность" value={newPos} onChange={(e) => setNewPos(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addPos()} />
              <button className="btn btn-primary btn-sm" onClick={addPos}>+</button>
            </div>
            {positions.map((p) => (
              <div key={p.id} className="team-row team-head">
                <span>{p.name}</span>
                <button className="btn btn-ghost btn-sm" onClick={async () => { await api.deletePosition(p.id); reload(); }}>Удалить</button>
              </div>
            ))}
          </>
        )}

        {tab === 'groups' && (
          <>
            <div className="add-user" style={{ marginBottom: 12 }}>
              <input className="input add-user-input" placeholder="Название группы/отдела" value={newGroup.name} onChange={(e) => setNewGroup({ ...newGroup, name: e.target.value })} />
              <div className="team-rate">
                <select className="input" value={newGroup.kind} onChange={(e) => setNewGroup({ ...newGroup, kind: e.target.value })}><option value="group">группа</option><option value="department">отдел</option></select>
                <button className="btn btn-primary btn-sm" onClick={addGroup}>Создать</button>
              </div>
            </div>
            {groups.map((g) => (
              <div key={g.id} className="team-row">
                <div className="team-head">
                  <span>{g.name} <span className="badge">{g.kind}</span></span>
                  <button className="btn btn-ghost btn-sm" onClick={async () => { await api.deleteGroup(g.id); reload(); }}>Удалить</button>
                </div>
                <div className="team-rate">
                  <select className="input" value={memberPick[g.id] ?? ''} onChange={(e) => setMemberPick((m) => ({ ...m, [g.id]: e.target.value }))}>
                    <option value="">— добавить участника —</option>
                    {users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
                  </select>
                  <button className="btn btn-sm" onClick={async () => { if (memberPick[g.id]) { await api.addGroupMember(g.id, memberPick[g.id]); reload(); } }}>+</button>
                </div>
              </div>
            ))}
          </>
        )}
      </aside>
    </div>
  );
}
