import { useEffect, useState } from 'react';
import { useAuth } from './state/auth';
import { api, ApiError } from './lib/api';
import { LoginPage } from './pages/LoginPage';
import { BoardPage } from './pages/BoardPage';
import { AcceptInvitePage } from './pages/AcceptInvitePage';
import { ProfilePanel } from './components/ProfilePanel';
import { IntegrationsPanel } from './components/IntegrationsPanel';
import { KnowledgePanel } from './components/KnowledgePanel';
import { Avatar } from './components/Avatar';
import { roleLabel } from './lib/labels';

export function App() {
  const { user, organizations, loading, logout, switchOrg, createOrg } = useAuth();
  const [tgCode, setTgCode] = useState<string | null>(null);
  const [showProfile, setShowProfile] = useState(false);
  const [showIntegrations, setShowIntegrations] = useState(false);
  const [showKnowledge, setShowKnowledge] = useState(false);
  const [avatarPath, setAvatarPath] = useState<string | null>(null);

  const onSwitchOrg = async (tenantId: string) => {
    if (tenantId === '__new__') {
      const name = window.prompt('Название новой организации:');
      if (name && name.trim()) await createOrg(name.trim());
      return;
    }
    if (user && tenantId !== user.tenantId) await switchOrg(tenantId);
  };

  // приглашение в команду: ссылка вида /?invite=<token>
  const inviteToken = new URLSearchParams(window.location.search).get('invite');

  useEffect(() => {
    if (user) api.me().then((m) => setAvatarPath(m.avatarUrl)).catch(() => undefined);
  }, [user]);

  if (inviteToken) return <AcceptInvitePage token={inviteToken} />;

  const linkTelegram = async () => {
    try {
      const r = await api.telegramLinkCode();
      setTgCode(r.code);
    } catch (e) {
      setTgCode(e instanceof ApiError ? e.message : 'ошибка');
    }
  };

  if (loading) {
    return (
      <div className="center-screen">
        <div className="spinner" />
      </div>
    );
  }

  if (!user) return <LoginPage />;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          TEAM<span>CRM</span>
        </div>
        <div className="topbar-right">
          <select className="org-switch" value={user.tenantId} onChange={(e) => onSwitchOrg(e.target.value)} title="Организация">
            {organizations.map((o) => <option key={o.tenantId} value={o.tenantId}>{o.name} · {roleLabel(o.role)}</option>)}
            {organizations.length === 0 && <option value={user.tenantId}>Моя организация</option>}
            <option value="__new__">+ Создать организацию…</option>
          </select>
          {tgCode && (
            <span className="badge" title="Отправьте код Telegram-боту для привязки">
              TG-код: <b>{tgCode}</b>
            </span>
          )}
          <button className="btn btn-ghost btn-sm" onClick={linkTelegram}>
            Привязать Telegram
          </button>
          {user.role !== 'client' && (
            <button className="btn btn-ghost btn-sm" onClick={() => setShowKnowledge(true)}>
              База знаний
            </button>
          )}
          {user.role === 'owner' && (
            <button className="btn btn-ghost btn-sm" onClick={() => setShowIntegrations(true)}>
              Интеграции
            </button>
          )}
          <button className="profile-btn" onClick={() => setShowProfile(true)} title="Личный кабинет">
            <Avatar path={avatarPath} fallback={user.fullName?.[0] ?? '?'} className="avatar-sm" />
            <span className="dim">{user.fullName}</span>
          </button>
          <span className="badge badge-role">{roleLabel(user.role)}</span>
          <button className="btn btn-ghost btn-sm" onClick={logout}>
            Выйти
          </button>
        </div>
      </header>
      <BoardPage key={user.tenantId} />
      {showProfile && <ProfilePanel onClose={() => setShowProfile(false)} onAvatar={setAvatarPath} />}
      {showIntegrations && <IntegrationsPanel onClose={() => setShowIntegrations(false)} />}
      {showKnowledge && <KnowledgePanel canManage={user.role === 'owner' || user.role === 'manager'} onClose={() => setShowKnowledge(false)} />}
    </div>
  );
}
