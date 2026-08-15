import { useEffect, useRef, useState } from 'react';
import { useAuth } from './state/auth';
import { api } from './lib/api';
import { LoginPage } from './pages/LoginPage';
import { BoardPage } from './pages/BoardPage';
import { AcceptInvitePage } from './pages/AcceptInvitePage';
import { JoinOrgPage } from './pages/JoinOrgPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { MyTasksPage } from './pages/MyTasksPage';
import { MeetingsPage } from './pages/MeetingsPage';
import { ProfilePanel } from './components/ProfilePanel';
import { IntegrationsPanel } from './components/IntegrationsPanel';
import { KnowledgePanel } from './components/KnowledgePanel';
import { ClientsPanel } from './components/ClientsPanel';
import { NlCommandModal } from './components/NlCommandModal';
import { InboxPanel } from './components/InboxPanel';
import { ClientPortal } from './pages/ClientPortal';
import { Avatar } from './components/Avatar';
import { roleLabel } from './lib/labels';

export function App() {
  const { user, organizations, loading, logout, switchOrg, createOrg } = useAuth();
  const [route, setRoute] = useState<'board' | 'profile' | 'mytasks' | 'meetings'>('board');
  // переход из «Моих задач» на доску проекта с открытой карточкой
  const [jumpTo, setJumpTo] = useState<{ projectId: string; taskId?: string } | undefined>();
  const [showIntegrations, setShowIntegrations] = useState(false);
  const [showKnowledge, setShowKnowledge] = useState(false);
  const [showClients, setShowClients] = useState(false);
  const [showNl, setShowNl] = useState(false);
  const [showInbox, setShowInbox] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [avatarPath, setAvatarPath] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // закрытие меню профиля по клику вне
  useEffect(() => {
    if (!menuOpen) return;
    const h = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [menuOpen]);

  const onSwitchOrg = async (tenantId: string) => {
    if (tenantId === '__new__') {
      const name = window.prompt('Название новой организации:');
      if (name && name.trim()) await createOrg(name.trim());
      return;
    }
    if (user && tenantId !== user.tenantId) await switchOrg(tenantId);
  };

  // приглашение в команду: одноразовое /?invite=<token> или многоразовое /?join=<token>;
  // сброс пароля по ссылке от владельца: /?reset=<token>
  const params = new URLSearchParams(window.location.search);
  const inviteToken = params.get('invite');
  const joinToken = params.get('join');
  const resetToken = params.get('reset');

  useEffect(() => {
    if (user) api.me().then((m) => setAvatarPath(m.avatarUrl)).catch(() => undefined);
  }, [user]);

  if (inviteToken) return <AcceptInvitePage token={inviteToken} />;
  if (joinToken) return <JoinOrgPage token={joinToken} />;
  if (resetToken) return <ResetPasswordPage token={resetToken} />;

  if (loading) {
    return (
      <div className="center-screen">
        <div className="spinner" />
      </div>
    );
  }

  if (!user) return <LoginPage />;

  // клиент видит отдельный портал (без внутренних досок/финансов)
  if (user.role === 'client') return <ClientPortal />;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand" onClick={() => setRoute('board')} style={{ cursor: 'pointer' }} title="К доскам">
          TEAM<span>CRM</span>
        </div>
        <div className="topbar-right">
          <select className="org-switch" value={user.tenantId} onChange={(e) => onSwitchOrg(e.target.value)} title="Организация">
            {organizations.map((o) => <option key={o.tenantId} value={o.tenantId}>{o.name} · {roleLabel(o.role)}</option>)}
            {organizations.length === 0 && <option value={user.tenantId}>Моя организация</option>}
            <option value="__new__">+ Создать организацию…</option>
          </select>

          <button className="btn btn-primary btn-sm" onClick={() => setShowNl(true)} title="Создать задачу или сделку обычным языком (текст или голос)">
            ⚡ Создать
          </button>

          <nav className="topbar-nav" aria-label="Разделы">
            <button
              className={`btn btn-ghost btn-sm ${route === 'mytasks' ? 'nav-active' : ''}`}
              onClick={() => setRoute(route === 'mytasks' ? 'board' : 'mytasks')}
              title="Мои задачи и порученные — по всем проектам"
            >
              ✅ Мои задачи
            </button>
            <button
              className={`btn btn-ghost btn-sm ${route === 'meetings' ? 'nav-active' : ''}`}
              onClick={() => setRoute(route === 'meetings' ? 'board' : 'meetings')}
              title="Разбор записей встреч: стенограмма, сводка, задачи"
            >
              🎙 Встречи
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setShowKnowledge(true)} title="База знаний: спросить ИИ по архиву компании">
              📚 База знаний
            </button>
            {(user.role === 'owner' || user.role === 'manager') && (
              <button className="btn btn-ghost btn-sm" onClick={() => setShowClients(true)} title="Клиенты">
                🤝 Клиенты
              </button>
            )}
            {(user.role === 'owner' || user.role === 'manager') && (
              <button className="btn btn-ghost btn-sm" onClick={() => setShowInbox(true)} title="Входящие: письма и голосовые заметки → черновики задач">
                📥 Входящие
              </button>
            )}
            {user.role === 'owner' && (
              <button className="btn btn-ghost btn-sm" onClick={() => setShowIntegrations(true)} title="Интеграции: Битрикс24, ИИ-ключи, промпты, Telegram">
                🔌 Интеграции
              </button>
            )}
          </nav>

          <div className="user-menu" ref={menuRef}>
            <button className="profile-btn" onClick={() => setMenuOpen((v) => !v)} title="Профиль и настройки" aria-haspopup="menu" aria-expanded={menuOpen}>
              <Avatar path={avatarPath} fallback={user.fullName?.[0] ?? '?'} className="avatar-sm" />
              <span className="dim profile-name">{user.fullName}</span>
              <span className="caret">▾</span>
            </button>
            {menuOpen && (
              <div className="menu-pop" role="menu">
                <div className="menu-role">{roleLabel(user.role)}</div>
                <button className="menu-item" role="menuitem" onClick={() => { setRoute('profile'); setMenuOpen(false); }}>Личный кабинет</button>
                <button className="menu-item menu-danger" role="menuitem" onClick={() => { setMenuOpen(false); logout(); }}>Выйти</button>
              </div>
            )}
          </div>
        </div>
      </header>
      {route === 'profile' && <ProfilePanel onClose={() => setRoute('board')} onAvatar={setAvatarPath} />}
      {route === 'mytasks' && (
        <MyTasksPage onOpenProject={(projectId, taskId) => { setJumpTo({ projectId, taskId }); setRoute('board'); }} />
      )}
      {route === 'meetings' && <MeetingsPage />}
      {route === 'board' && <BoardPage key={`${user.tenantId}:${jumpTo?.taskId ?? ''}`} initial={jumpTo} />}
      {showIntegrations && <IntegrationsPanel onClose={() => setShowIntegrations(false)} />}
      {showKnowledge && <KnowledgePanel canManage={user.role === 'owner' || user.role === 'manager'} onClose={() => setShowKnowledge(false)} />}
      {showClients && <ClientsPanel onClose={() => setShowClients(false)} />}
      {showNl && <NlCommandModal onClose={() => setShowNl(false)} />}
      {showInbox && <InboxPanel onClose={() => setShowInbox(false)} />}
    </div>
  );
}
