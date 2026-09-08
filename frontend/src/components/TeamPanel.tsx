import { useEffect, useState } from 'react';
import { EmptyState } from './EmptyState';
import { Icon } from './Icon';
import { api, ApiError } from '../lib/api';
import { ASSIGNABLE_ROLES, roleLabel } from '../lib/labels';
import { MONETIZATION_ENABLED } from '../config';
import { useAuth } from '../state/auth';
import { useEscape } from '../hooks/useEscape';

type Tab = 'people' | 'positions' | 'groups';
const roleOptions = ASSIGNABLE_ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>);

/** kind приходит из базы по-английски — в интерфейсе он не нужен в таком виде. */
const KIND_LABEL: Record<string, string> = { department: 'отдел', group: 'группа' };
const inGroup = (user: any, groupId: string) =>
  (user.groups ?? []).some((g: any) => String(g.id) === String(groupId));
const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} ${one}`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
};

export function TeamPanel({ onClose }: { onClose: () => void }) {
  useEscape(onClose); // закрытие с клавиатуры, а не только крестиком
  const [tab, setTab] = useState<Tab>('people');
  const [users, setUsers] = useState<any[]>([]);
  const [positions, setPositions] = useState<any[]>([]);
  const [groups, setGroups] = useState<any[]>([]);
  const [rate, setRate] = useState<Record<string, string>>({});
  const [metrics, setMetrics] = useState<Record<string, any>>({});
  const [msg, setMsg] = useState('');
  const [invite, setInvite] = useState<{ email: string; link: string } | null>(null);
  const [links, setLinks] = useState<any[]>([]);
  const [linkForm, setLinkForm] = useState({ role: 'member', maxUses: '', expiresInDays: '' });
  const [newLink, setNewLink] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  // сброс пароля сотруднику — только владелец (эндпоинт закрыт ролью owner)
  const { user: me } = useAuth();
  const [reset, setReset] = useState<{ userId: string; link: string; alsoAffectsOrgs: string[] } | null>(null);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 2500); };
  const reload = async () => {
    setUsers(await api.listUsers().catch(() => []));
    setPositions(await api.listPositions().catch(() => []));
    setGroups(await api.listGroups().catch(() => []));
    setLinks(await api.listInviteLinks().catch(() => []));
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

  /** Выдать сотруднику ссылку на смену пароля. Пароль задаёт он сам — владелец его не видит. */
  const makeResetLink = async (userId: string) => {
    try {
      const r = await api.createPasswordResetLink(userId);
      setReset({ userId, link: `${window.location.origin}/?reset=${r.token}`, alsoAffectsOrgs: r.alsoAffectsOrgs });
    } catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); }
  };

  // --- многоразовая ссылка ---
  const createLink = async () => {
    try {
      const r = await api.createInviteLink({
        role: linkForm.role,
        maxUses: linkForm.maxUses ? Number(linkForm.maxUses) : undefined,
        expiresInDays: linkForm.expiresInDays ? Number(linkForm.expiresInDays) : undefined,
      });
      setNewLink(`${window.location.origin}/?join=${r.token}`);
      setLinkForm({ role: 'member', maxUses: '', expiresInDays: '' });
      reload();
    } catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); }
  };
  const deleteLink = async (id: string) => {
    try { await api.deleteInviteLink(id); reload(); } catch { /* */ }
  };

  // --- positions ---
  const [newPos, setNewPos] = useState('');
  const addPos = async () => { if (!newPos.trim()) return; try { await api.createPosition(newPos.trim()); setNewPos(''); reload(); } catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); } };

  // --- groups ---
  const [newGroup, setNewGroup] = useState({ name: '', kind: 'group' });
  const addGroup = async () => { if (!newGroup.name.trim()) return; try { await api.createGroup({ name: newGroup.name.trim(), kind: newGroup.kind }); setNewGroup({ name: '', kind: 'group' }); reload(); } catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); } };

  /** Удаление спрашивает подтверждение: раньше промах по кнопке молча сносил отдел с людьми. */
  const removeGroup = async (id: string, name: string, count: number) => {
    const warn = count > 0 ? ` В ней ${plural(count, 'человек', 'человека', 'человек')} — они останутся в системе, но потеряют это подразделение.` : '';
    if (!window.confirm(`Удалить «${name}»?${warn}`)) return;
    try { await api.deleteGroup(id); await reload(); }
    catch (e) { flash(e instanceof ApiError ? e.message : 'Не удалось удалить группу'); }
  };

  // Состав группы берём из списка сотрудников: он и так приходит с их группами,
  // поэтому обе вкладки показывают одно и то же и не расходятся между собой.
  const membersOf = (groupId: string) => users.filter((u) => inGroup(u, groupId));
  const [busyGroup, setBusyGroup] = useState('');
  /** Добавить/убрать человека в группе. Обе вкладки зовут это же — правки видны сразу везде. */
  const toggleMembership = async (groupId: string, userId: string, isMember: boolean) => {
    setBusyGroup(`${groupId}:${userId}`);
    try {
      if (isMember) await api.removeGroupMember(groupId, userId);
      else await api.addGroupMember(groupId, userId);
      await reload();
    } catch (e) {
      flash(e instanceof ApiError ? e.message : 'Не удалось изменить состав группы');
    } finally { setBusyGroup(''); }
  };

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head"><h3><Icon name="users" size={18} /> Команда</h3><button className="btn btn-ghost btn-sm" onClick={onClose} title="Закрыть"><Icon name="close" /></button></div>
        <div className="tabs">
          <button className={`tab ${tab === 'people' ? 'active' : ''}`} onClick={() => setTab('people')}>Сотрудники</button>
          <button className={`tab ${tab === 'positions' ? 'active' : ''}`} onClick={() => setTab('positions')}>Должности</button>
          <button className={`tab ${tab === 'groups' ? 'active' : ''}`} onClick={() => setTab('groups')}>Группы</button>
        </div>
        {msg && <div className="dim">{msg}</div>}

        {tab === 'people' && (
          <>
            <div className="panel-toolbar">
              <div className="drawer-section-title" style={{ margin: 0 }}>Сотрудники ({users.length})</div>
              <button className="btn btn-primary btn-sm" onClick={() => setShowAdd((v) => !v)}>{showAdd ? 'Скрыть' : '＋ Добавить людей'}</button>
            </div>

            {showAdd && (
              <div className="add-area">
                <div className="dim" style={{ fontSize: 12, marginBottom: 4 }}>Выберите подходящий способ:</div>

                <div className="drawer-section-title"><Icon name="link" size={14} /> Ссылка для многих</div>
                <div className="add-user">
                  <div className="dim" style={{ fontSize: 12 }}>Одна ссылка — много участников (для чата/рассылки). Каждый вводит свои данные. Лимит и срок — по желанию.</div>
                  <div className="drawer-grid2">
                    <select className="input" value={linkForm.role} onChange={(e) => setLinkForm({ ...linkForm, role: e.target.value })}>
                      <option value="member">Участник</option>
                      <option value="manager">Менеджер</option>
                    </select>
                    <input className="input" type="number" min={1} placeholder="Лимит входов" value={linkForm.maxUses} onChange={(e) => setLinkForm({ ...linkForm, maxUses: e.target.value })} />
                  </div>
                  <input className="input" type="number" min={1} placeholder="Срок действия, дней" value={linkForm.expiresInDays} onChange={(e) => setLinkForm({ ...linkForm, expiresInDays: e.target.value })} />
                  <button className="btn btn-sm" onClick={createLink}>Создать ссылку</button>
                  {newLink && (
                    <div className="invite-box">
                      Ссылка (можно раздать многим):
                      <input className="input" readOnly value={newLink} onFocus={(e) => e.currentTarget.select()} />
                    </div>
                  )}
                </div>
                {links.length > 0 && links.map((l) => (
                  <div key={l.id} className={`team-row ${l.is_active ? '' : 'team-inactive'}`}>
                    <div className="team-head">
                      <span>
                        {roleLabel(l.role_code)} · вошло {l.uses}{l.max_uses ? ` из ${l.max_uses}` : ''}
                        {!l.is_active && <span className="badge badge-muted">отключена</span>}
                        {l.expires_at && <span className="dim" style={{ fontSize: 11 }}> · до {new Date(l.expires_at).toLocaleDateString()}</span>}
                      </span>
                      {l.is_active && <button className="btn btn-ghost btn-sm" onClick={() => deleteLink(l.id)}>Отключить</button>}
                    </div>
                  </div>
                ))}

                <div className="drawer-section-title"><Icon name="mail" size={14} /> Приглашение одному</div>
                <div className="add-user">
                  <div className="dim" style={{ fontSize: 12 }}>Персональная ссылка на конкретный e-mail (одноразовая).</div>
                  <input className="input add-user-input" placeholder="E-mail" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} />
                  <div className="drawer-grid2">
                    <select className="input" value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value })}>{roleOptions}</select>
                    <select className="input" value={inv.positionId} onChange={(e) => setInv({ ...inv, positionId: e.target.value })}><option value="">— должность —</option>{positions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
                  </div>
                  <button className="btn btn-sm" onClick={sendInvite}>Создать приглашение</button>
                  {invite && (
                    <div className="invite-box">
                      Ссылка для {invite.email}:
                      <input className="input" readOnly value={invite.link} onFocus={(e) => e.currentTarget.select()} />
                    </div>
                  )}
                </div>

                <div className="drawer-section-title">⌨️ Создать вручную</div>
                <div className="add-user">
                  <div className="dim" style={{ fontSize: 12 }}>Сразу задать пароль (без письма-приглашения).</div>
                  <input className="input add-user-input" placeholder="Имя" value={nu.fullName} onChange={(e) => setNu({ ...nu, fullName: e.target.value })} />
                  <input className="input add-user-input" placeholder="E-mail" value={nu.email} onChange={(e) => setNu({ ...nu, email: e.target.value })} />
                  <input className="input add-user-input" type="password" placeholder="Пароль (≥8)" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} />
                  <div className="drawer-grid2">
                    <select className="input" value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value })}>{roleOptions}</select>
                    <select className="input" value={nu.positionId} onChange={(e) => setNu({ ...nu, positionId: e.target.value })}><option value="">— должность —</option>{positions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
                  </div>
                  <button className="btn btn-primary btn-sm" style={{ width: '100%' }} onClick={addUser}>Добавить сотрудника</button>
                </div>
              </div>
            )}

            {users.map((u) => (
              <div key={u.id} className={`team-row ${u.isActive ? '' : 'team-inactive'}`}>
                <div className="team-head">
                  <span>{u.fullName} {!u.isActive && <span className="badge badge-muted">неактивен</span>}</span>
                  <span className="dim">{u.positionName ?? '—'}</span>
                </div>
                <div className="drawer-grid2">
                  <select className="input" value={u.role} onChange={(e) => patchUser(u.id, { role: e.target.value })}>{roleOptions}</select>
                  <select className="input" value={u.positionId ?? ''} onChange={(e) => patchUser(u.id, { positionId: e.target.value || null })}><option value="">— должность —</option>{positions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
                </div>
                {/* Группы правятся прямо здесь: думают о них обычно от человека
                    («куда его определить»), а не от списка отделов. */}
                {groups.length > 0 && (
                  <div className="chip-row" style={{ marginTop: 6 }}>
                    {groups.map((g) => {
                      const has = inGroup(u, g.id);
                      return (
                        <button
                          key={g.id}
                          className={`group-chip ${has ? 'group-chip-on' : ''}`}
                          disabled={busyGroup === `${g.id}:${u.id}`}
                          onClick={() => toggleMembership(g.id, u.id, has)}
                          title={has ? `Убрать из «${g.name}»` : `Добавить в «${g.name}»`}
                        >
                          {g.name}
                        </button>
                      );
                    })}
                  </div>
                )}
                <div className="team-rate">
                  {MONETIZATION_ENABLED && (
                    <>
                      <input className="input" type="number" placeholder="₽/час" value={rate[u.id] ?? ''} onChange={(e) => setRate((r) => ({ ...r, [u.id]: e.target.value }))} />
                      <button className="btn btn-sm" onClick={() => saveRate(u.id)}>Ставка</button>
                    </>
                  )}
                  <button className="btn btn-ghost btn-sm" onClick={() => loadMetrics(u.id)}>Метрики</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => patchUser(u.id, { isActive: !u.isActive })}>{u.isActive ? 'Деактив.' : 'Вкл.'}</button>
                  {me?.role === 'owner' && (
                    <button className="btn btn-ghost btn-sm" onClick={() => makeResetLink(u.id)} title="Выдать ссылку на смену пароля">Сброс пароля</button>
                  )}
                </div>
                {reset && reset.userId === u.id && (
                  <div className="invite-box">
                    Ссылка на смену пароля (действует 2 часа, одноразовая). Передайте её сотруднику — пароль он задаст сам:
                    <input className="input" readOnly value={reset.link} onFocus={(e) => e.currentTarget.select()} />
                    {reset.alsoAffectsOrgs.length > 0 && (
                      <div className="error-text" style={{ fontSize: 12 }}>
                        <Icon name="alert" size={13} /> Пароль общий для всех организаций этого человека — смена затронет также: {reset.alsoAffectsOrgs.join(', ')}.
                      </div>
                    )}
                    <button className="btn btn-ghost btn-sm" onClick={() => setReset(null)}>Скрыть</button>
                  </div>
                )}
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
            {/*
              Право публиковать новости — на должности, а не на человеке: при смене
              пресс-секретаря оно переезжает вместе с должностью, и не надо вспоминать,
              кому его когда-то выдали персонально. Раздаёт владелец.
            */}
            <p className="dim">
              Отметьте должности, которым доверено публиковать новости компании
              (пресс-секретарь, помощник руководителя). Руководители публикуют всегда.
            </p>
            {positions.map((p) => (
              <div key={p.id} className="team-row team-head">
                <span>{p.name}</span>
                <span className="team-rate">
                  <label className="notify-row" title="Может публиковать новости компании">
                    <input
                      type="checkbox"
                      checked={!!p.can_post_news}
                      disabled={me?.role !== 'owner'}
                      onChange={async (e) => {
                        try { await api.setPositionNewsRight(p.id, e.target.checked); reload(); }
                        catch (err) { flash(err instanceof ApiError ? err.message : 'Не удалось изменить'); }
                      }}
                    />
                    Пишет новости
                  </label>
                  <button className="btn btn-ghost btn-sm" onClick={async () => { await api.deletePosition(p.id); reload(); }}>Удалить</button>
                </span>
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
            {groups.length === 0 && (
              <EmptyState
                compact
                icon="users"
                title="Групп пока нет"
                hint="Отделы и группы нужны, чтобы понимать, кто чем занимается: рядом с именем в чатах видно подразделение человека. Создайте первую формой выше."
              />
            )}

            {groups.map((g) => {
              const members = membersOf(g.id);
              const outside = users.filter((u) => !inGroup(u, g.id));
              return (
                <div key={g.id} className="team-row">
                  <div className="team-head">
                    <span>
                      {g.name} <span className="badge badge-muted">{KIND_LABEL[g.kind] ?? g.kind}</span>{' '}
                      <span className="dim">{plural(members.length, 'человек', 'человека', 'человек')}</span>
                    </span>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => removeGroup(g.id, g.name, members.length)}
                      title="Удалить группу"
                    >
                      Удалить
                    </button>
                  </div>

                  {members.length === 0
                    ? <div className="dim group-empty">Пока никого — добавьте сотрудников списком ниже.</div>
                    : (
                      <div className="chip-row">
                        {members.map((u) => (
                          <button
                            key={u.id}
                            className="member-chip"
                            disabled={busyGroup === `${g.id}:${u.id}`}
                            onClick={() => toggleMembership(g.id, u.id, true)}
                            title={`Убрать ${u.fullName} из «${g.name}»`}
                          >
                            <span className="avatar-xs avatar-ph">{u.fullName[0]?.toUpperCase()}</span>
                            {u.fullName}
                            <Icon name="close" size={11} />
                          </button>
                        ))}
                      </div>
                    )}

                  {/* Выбор из списка сразу добавляет: отдельная кнопка «+» только добавляла шаг,
                      на котором забывали нажать. В списке — лишь те, кого в группе ещё нет. */}
                  {outside.length > 0 && (
                    <select
                      className="input group-add"
                      value=""
                      onChange={(e) => e.target.value && toggleMembership(g.id, e.target.value, false)}
                    >
                      <option value="">+ добавить сотрудника…</option>
                      {outside.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
                    </select>
                  )}
                </div>
              );
            })}
          </>
        )}
      </aside>
    </div>
  );
}
