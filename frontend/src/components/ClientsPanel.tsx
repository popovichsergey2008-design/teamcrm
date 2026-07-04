import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';

/** Управление клиентами портала (owner/manager): компании, приглашения, привязка проектов. */
export function ClientsPanel({ onClose }: { onClose: () => void }) {
  const [clients, setClients] = useState<any[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [msg, setMsg] = useState('');
  const [name, setName] = useState('');
  const [invite, setInvite] = useState<{ email: string; link: string } | null>(null);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3500); };
  const reload = () => {
    api.portalClients().then(setClients).catch(() => undefined);
    api.listProjects().then(setProjects).catch(() => undefined);
  };
  useEffect(() => { reload(); }, []);

  const create = async () => {
    if (!name.trim()) return flash('Укажите название клиента');
    try { await api.portalCreateClient({ name: name.trim() }); setName(''); flash('Клиент создан'); reload(); }
    catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); }
  };
  const inviteUser = async (cid: string, email: string) => {
    if (!email?.trim()) return flash('Укажите e-mail');
    try {
      const r = await api.portalInviteClient(cid, email.trim());
      setInvite({ email: r.email, link: `${window.location.origin}/?invite=${r.token}` });
    } catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); }
  };
  const assign = async (projectId: string, clientId: string) => {
    try { await api.portalAssignProject(projectId, clientId || null); flash('Проект привязан'); reload(); }
    catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); }
  };

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head"><h3>Клиенты и портал</h3><button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button></div>
        <div className="dim" style={{ fontSize: 12 }}>Клиент видит в портале только прогресс/статусы/сроки своих проектов — без финансов.</div>
        {msg && <div className="dim">{msg}</div>}

        <div className="drawer-section-title">Добавить клиента</div>
        <div className="team-rate">
          <input className="input" placeholder="Название компании-клиента" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
          <button className="btn btn-primary btn-sm" onClick={create}>+</button>
        </div>

        <div className="drawer-section-title">Привязка проектов к клиентам</div>
        {projects.map((p) => (
          <div key={p.id} className="team-rate" style={{ marginBottom: 4 }}>
            <span style={{ flex: 1, fontSize: 13 }}>{p.name}</span>
            <select className="input" defaultValue="" onChange={(e) => assign(p.id, e.target.value)}>
              <option value="">— клиент —</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        ))}

        <div className="drawer-section-title">Клиенты ({clients.length})</div>
        {clients.map((c) => (
          <ClientRow key={c.id} client={c} onInvite={inviteUser} />
        ))}
        {invite && (
          <div className="invite-box">
            Ссылка-приглашение для {invite.email}:
            <input className="input" readOnly value={invite.link} onFocus={(e) => e.currentTarget.select()} />
          </div>
        )}
      </aside>
    </div>
  );
}

function ClientRow({ client, onInvite }: { client: any; onInvite: (cid: string, email: string) => void }) {
  const [email, setEmail] = useState('');
  return (
    <div className="team-row">
      <div className="team-head">
        <span>{client.name} <span className="dim" style={{ fontSize: 12 }}>· проектов: {client.projects}, вход в портал: {client.portal_users}</span></span>
      </div>
      <div className="team-rate">
        <input className="input" placeholder="e-mail для доступа в портал" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button className="btn btn-sm" onClick={() => { onInvite(client.id, email); setEmail(''); }}>Пригласить</button>
      </div>
    </div>
  );
}
