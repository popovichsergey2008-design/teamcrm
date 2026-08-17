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
import { CallPanel } from './components/CallPanel';
import { ChatsPage } from './pages/ChatsPage';
import { IncomingCallDialog, useIncomingCalls } from './components/IncomingCall';
import { useChatNotifications } from './hooks/useChatNotifications';
import { Icon } from './components/Icon';
import { ThemeSwitch } from './components/ThemeSwitch';
import { ProfilePanel } from './components/ProfilePanel';
import { IntegrationsPanel } from './components/IntegrationsPanel';
import { KnowledgePanel } from './components/KnowledgePanel';
import { ClientsPanel } from './components/ClientsPanel';
import { NlCommandModal } from './components/NlCommandModal';
import { InboxPanel } from './components/InboxPanel';
import { ClientPortal } from './pages/ClientPortal';
import { Avatar } from './components/Avatar';
import { roleLabel } from './lib/labels';

const ROUTES = ['board', 'profile', 'mytasks', 'meetings', 'chats'] as const;
type Route = (typeof ROUTES)[number];
const ROUTE_KEY = 'teamcrm.route';

export function App() {
  const { user, organizations, loading, logout, switchOrg, createOrg } = useAuth();
  const [route, setRouteState] = useState<Route>(() => {
    const saved = localStorage.getItem(ROUTE_KEY);
    return ROUTES.includes(saved as Route) ? (saved as Route) : 'board';
  });
  // раздел запоминается: обновление страницы не должно выкидывать из чатов на доску
  const setRoute = (r: Route) => { setRouteState(r); localStorage.setItem(ROUTE_KEY, r); };
  // переход из «Моих задач» на доску проекта с открытой карточкой
  const [jumpTo, setJumpTo] = useState<{ projectId: string; taskId?: string } | undefined>();
  // созвон: id комнаты, в которой мы сейчас, и список идущих в организации
  const [callId, setCallId] = useState<string | null>(null);
  const [callInvite, setCallInvite] = useState<string[]>([]);
  // какой чат открыт — чтобы не слать уведомление о сообщении, которое человек и так видит
  const [openChatId, setOpenChatId] = useState<string | null>(null);
  const [activeCalls, setActiveCalls] = useState<{ id: string; participants: { displayName: string }[] }[]>([]);
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

  // Кто-то уже созванивается — показываем баннер с возможностью присоединиться.
  // Опрос, а не push: постоянное WS-соединение ради этого держать не нужно.
  useEffect(() => {
    if (!user || user.role === 'client') return;
    const poll = () => api.activeCalls().then(setActiveCalls).catch(() => undefined);
    poll();
    const t = setInterval(poll, 10_000);
    return () => clearInterval(t);
  }, [user]);

  /** Присоединиться к уже идущему созвону. */
  const joinActiveCall = () => {
    const existing = activeCalls[0];
    if (!existing) return;
    setCallInvite([]);
    setCallId(existing.id);
  };

  /**
   * Звонок из чата: поднимаем комнату и зовём собеседников — им прилетит входящий.
   * Для чата проекта передаём проект: тогда задачи из стенограммы сразу лягут в его доску.
   */
  const callFromChat = async (chat: {
    id: string; title: string; memberIds: string[]; projectId?: string | null; withAi?: boolean;
  }) => {
    try {
      const room = await api.startCall(chat.projectId ?? undefined, chat.withAi === true);
      setCallInvite(chat.memberIds);
      setCallId(room.id);
    } catch { /* недоступность медиа покажет само окно звонка */ }
  };

  const { incoming, accept, decline } = useIncomingCalls(!!user && user.role !== 'client');
  const { unread } = useChatNotifications(
    !!user && user.role !== 'client',
    route === 'chats' ? openChatId : null,
    () => setRoute('chats'),
  );

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
            <Icon name="zap" size={15} /> Создать
          </button>

          <nav className="topbar-nav" aria-label="Разделы">
            <button
              className={`btn btn-ghost btn-sm ${route === 'mytasks' ? 'nav-active' : ''}`}
              onClick={() => setRoute(route === 'mytasks' ? 'board' : 'mytasks')}
              title="Мои задачи и порученные — по всем проектам"
            >
              <Icon name="check-circle" size={15} /> Мои задачи
            </button>
            <button
              className={`btn btn-ghost btn-sm ${route === 'meetings' ? 'nav-active' : ''}`}
              onClick={() => setRoute(route === 'meetings' ? 'board' : 'meetings')}
              title="Разбор записей встреч: стенограмма, сводка, задачи"
            >
              <Icon name="record" size={15} /> Встречи
            </button>
            <button
              className={`btn btn-ghost btn-sm ${route === 'chats' ? 'nav-active' : ''}`}
              onClick={() => setRoute(route === 'chats' ? 'board' : 'chats')}
              title="Чаты команды: личные, группы и обсуждения проектов"
            >
              <Icon name="chat" size={15} /> Чаты
              {unread > 0 && <span className="nav-badge">{unread > 99 ? '99+' : unread}</span>}
            </button>
            {/* Звонок начинают из чата. Здесь остаётся только вход в ИДУЩИЙ созвон —
                иначе к разговору не присоединиться тому, кого не позвали. */}
            {activeCalls.length > 0 && (
              <button className="btn btn-ghost btn-sm nav-active" onClick={joinActiveCall} title="Идёт созвон — присоединиться">
                <Icon name="phone" size={15} /> Идёт созвон · {activeCalls[0].participants.length}
              </button>
            )}
            <button className="btn btn-ghost btn-sm" onClick={() => setShowKnowledge(true)} title="База знаний: спросить ИИ по архиву компании">
              <Icon name="book" size={15} /> База знаний
            </button>
            {(user.role === 'owner' || user.role === 'manager') && (
              <button className="btn btn-ghost btn-sm" onClick={() => setShowClients(true)} title="Клиенты">
                <Icon name="handshake" size={15} /> Клиенты
              </button>
            )}
            {(user.role === 'owner' || user.role === 'manager') && (
              <button className="btn btn-ghost btn-sm" onClick={() => setShowInbox(true)} title="Входящие: письма и голосовые заметки → черновики задач">
                <Icon name="inbox" size={15} /> Входящие
              </button>
            )}
            {user.role === 'owner' && (
              <button className="btn btn-ghost btn-sm" onClick={() => setShowIntegrations(true)} title="Интеграции: Битрикс24, ИИ-ключи, промпты, Telegram">
                <Icon name="plug" size={15} /> Интеграции
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
                <button className="menu-item" role="menuitem" onClick={() => { setRoute('profile'); setMenuOpen(false); }}>
                  <Icon name="user" size={15} /> Личный кабинет
                </button>
                <div className="menu-theme">
                  <span className="dim">Тема</span>
                  <ThemeSwitch />
                </div>
                <button className="menu-item menu-danger" role="menuitem" onClick={() => { setMenuOpen(false); logout(); }}>
                  <Icon name="logout" size={15} /> Выйти
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
      {route === 'profile' && <ProfilePanel onClose={() => setRoute('board')} onAvatar={setAvatarPath} />}
      {route === 'mytasks' && (
        <MyTasksPage onOpenProject={(projectId, taskId) => { setJumpTo({ projectId, taskId }); setRoute('board'); }} />
      )}
      {route === 'chats' && <ChatsPage onCall={callFromChat} onActiveChat={setOpenChatId} />}
      {route === 'meetings' && <MeetingsPage />}
      {route === 'board' && <BoardPage key={`${user.tenantId}:${jumpTo?.taskId ?? ''}`} initial={jumpTo} />}
      {callId && <CallPanel meetingId={callId} inviteUserIds={callInvite} onClose={() => { setCallId(null); setCallInvite([]); }} />}
      {incoming && !callId && (
        <IncomingCallDialog
          call={incoming}
          onAccept={() => { const id = accept(); if (id) { setCallInvite([]); setCallId(id); } }}
          onDecline={decline}
        />
      )}
      {showIntegrations && <IntegrationsPanel onClose={() => setShowIntegrations(false)} />}
      {showKnowledge && <KnowledgePanel canManage={user.role === 'owner' || user.role === 'manager'} onClose={() => setShowKnowledge(false)} />}
      {showClients && <ClientsPanel onClose={() => setShowClients(false)} />}
      {showNl && <NlCommandModal onClose={() => setShowNl(false)} />}
      {showInbox && <InboxPanel onClose={() => setShowInbox(false)} />}
    </div>
  );
}
