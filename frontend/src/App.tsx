import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from './state/auth';
import { api } from './lib/api';
import { LoginPage } from './pages/LoginPage';
import { BoardPage } from './pages/BoardPage';
import { AcceptInvitePage } from './pages/AcceptInvitePage';
import { JoinOrgPage } from './pages/JoinOrgPage';
import { GuestMeetPage } from './pages/GuestMeetPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { CalendarPage } from './pages/CalendarPage';
import { FeedPage } from './pages/FeedPage';
import { FocusPage } from './pages/FocusPage';
import { MeetingsPage } from './pages/MeetingsPage';
import { RadarPage } from './pages/RadarPage';
import { SettingsPage } from './pages/SettingsPage';
import { CallPanel } from './components/CallPanel';
import { ChatsPage } from './pages/ChatsPage';
import { IncomingCallDialog, useIncomingCalls } from './components/IncomingCall';
import { useCalendarReminders } from './hooks/useCalendarReminders';
import { useChatNotifications } from './hooks/useChatNotifications';
import { useNavCounters } from './hooks/useNavCounters';
import { Sidebar } from './components/Sidebar';
import { Icon } from './components/Icon';
import { ProfilePanel } from './components/ProfilePanel';
import { NlCommandModal } from './components/NlCommandModal';
import { CommandPalette } from './components/CommandPalette';
import { SecretaryPanel } from './components/SecretaryPanel';
import { InboxPanel } from './components/InboxPanel';
import { ClientPortal } from './pages/ClientPortal';
import { Toasts } from './components/Toasts';
import { navigate, parsePath, Section, useRoute } from './lib/router';
import { dropCache } from './lib/cache';
import { useShortcuts } from './hooks/useShortcuts';
import { ShortcutsHelp } from './components/ShortcutsHelp';
import { prefetchFocus } from './pages/FocusPage';
import { prefetchRadar } from './pages/RadarPage';

/**
 * Обёртка раздела, который остаётся жить после ухода с него.
 * `display: none` вместо размонтирования: React сохраняет состояние, браузер —
 * позицию прокрутки, а сеть не трогается вовсе.
 */
function Pane({ active, children }: { active: boolean; children: ReactNode }) {
  return <div className="pane" style={{ display: active ? 'flex' : 'none' }}>{children}</div>;
}

export function App() {
  const { user, organizations, loading, logout, switchOrg, createOrg } = useAuth();
  const route = useRoute();

  /**
   * Доска умеет принимать «куда прыгнуть» только при монтировании, поэтому переход
   * ИЗВНЕ (из фокуса, по уведомлению, кнопкой «назад») отмечается сменой nonce —
   * он же ключ пересоздания. Обычное переключение разделов доску не трогает: она
   * остаётся жить в скрытой панели со всеми загруженными задачами.
   */
  const [boardJump, setBoardJump] = useState<{ projectId?: string; taskId?: string; nonce: number }>(
    () => ({ projectId: route.projectId, taskId: route.taskId, nonce: 0 }),
  );
  const boardReported = useRef<{ projectId?: string; taskId?: string }>({
    projectId: route.projectId,
    taskId: route.taskId,
  });

  // созвон: id комнаты, в которой мы сейчас, и список идущих в организации
  const [callId, setCallId] = useState<string | null>(null);
  const [callInvite, setCallInvite] = useState<string[]>([]);
  // какой чат открыт — чтобы не слать уведомление о сообщении, которое человек и так видит
  const [openChatId, setOpenChatId] = useState<string | null>(null);
  const [activeCalls, setActiveCalls] = useState<{ id: string; participants: { displayName: string }[] }[]>([]);
  // окно быстрой команды: null — закрыто; текст и голос приходят из командной строки
  const [nl, setNl] = useState<{ text?: string; voice?: boolean } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState<{ voice?: boolean } | null>(null);
  const [secretaryOpen, setSecretaryOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // какие разделы уже открывали: только их держим смонтированными
  const [visited, setVisited] = useState<Set<Section>>(() => new Set([route.section]));
  const [avatarPath, setAvatarPath] = useState<string | null>(null);

  useEffect(() => {
    setVisited((v) => (v.has(route.section) ? v : new Set(v).add(route.section)));
  }, [route.section]);

  const onSwitchOrg = async (tenantId: string) => {
    if (tenantId === '__new__') {
      const name = window.prompt('Название новой организации:');
      if (name && name.trim()) await createOrg(name.trim());
      return;
    }
    if (user && tenantId !== user.tenantId) {
      // данные прошлой организации не должны пережить переключение ни в кэше, ни в разделах
      dropCache();
      setVisited(new Set([route.section]));
      await switchOrg(tenantId);
    }
  };

  // приглашение в команду: одноразовое /?invite=<token> или многоразовое /?join=<token>;
  // сброс пароля по ссылке от владельца: /?reset=<token>
  const params = new URLSearchParams(window.location.search);
  const guestMeetToken = window.location.pathname.startsWith('/meet/')
    ? decodeURIComponent(window.location.pathname.slice('/meet/'.length)).replace(/\/+$/, '')
    : null;
  const inviteToken = params.get('invite');
  const joinToken = params.get('join');
  const resetToken = params.get('reset');

  useEffect(() => {
    if (user) api.me().then((m) => setAvatarPath(m.avatarUrl)).catch(() => undefined);
  }, [user]);

  // Кто-то уже созванивается — показываем вход в комнату. Опрос, а не push:
  // постоянное WS-соединение ради этого держать не нужно.
  useEffect(() => {
    if (!user || user.role === 'client') return;
    const poll = () => api.activeCalls().then(setActiveCalls).catch(() => undefined);
    poll();
    const t = setInterval(poll, 10_000);
    return () => clearInterval(t);
  }, [user]);

  // Адрес сменился извне доски (клик по разделу, «назад», уведомление) — пересобираем доску.
  // Подраздел («Клиенты») адрес занимает под себя, доска под ним остаётся как есть.
  useEffect(() => {
    if (route.section !== 'projects' || route.view) return;
    if (route.projectId === boardReported.current.projectId && route.taskId === boardReported.current.taskId) return;
    boardReported.current = { projectId: route.projectId, taskId: route.taskId };
    setBoardJump((j) => ({ projectId: route.projectId, taskId: route.taskId, nonce: j.nonce + 1 }));
  }, [route.section, route.view, route.projectId, route.taskId]);

  // Раздел, куда человеку закрыт вход, не должен оставаться в адресе: уводим на фокус.
  useEffect(() => {
    if (!user || user.role === 'client') return;
    const manager = user.role === 'owner' || user.role === 'manager';
    if (route.section === 'radar' && !manager) navigate({ section: 'focus' }, { replace: true });
    if (route.section === 'settings' && route.tab === 'integrations' && user.role !== 'owner') {
      navigate({ section: 'settings' }, { replace: true });
    }
  }, [user, route.section, route.tab]);

  useShortcuts(!!user && user.role !== 'client', {
    newTask: () => setNl({}),
    palette: () => setPaletteOpen({}),
    help: () => setHelpOpen((v) => !v),
    toggleSidebar: () => window.dispatchEvent(new Event('teamcrm:toggle-sidebar')),
    go: (section) => navigate({ section }),
  });

  /**
   * Какой чат открыт: нужен и уведомлениям, и адресу.
   * Ссылка обязана быть стабильной — иначе эффект внутри чатов пересобирается
   * на каждый рендер. Уход из раздела приходит как null уже после смены адреса,
   * поэтому переписываем адрес, только пока мы действительно в чатах.
   */
  const onActiveChat = useCallback((chatId: string | null) => {
    setOpenChatId(chatId);
    const now = parsePath(window.location.pathname);
    // «Встречи» — тоже раздел чата, но со своим адресом: перебивать его нельзя,
    // иначе уход в них тут же отбрасывал бы обратно в переписку.
    if (now.section !== 'chat' || now.view) return;
    navigate({ section: 'chat', chatId: chatId ?? undefined }, { replace: true });
  }, []);

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
    // Уже в созвоне — второй не начинаем. Иначе собеседник, с которым вы и так
    // говорите, получал вызов в новую комнату, и разговор рвался пополам.
    if (callId) return;
    try {
      const room = await api.startCall(chat.projectId ?? undefined, chat.withAi === true);
      setCallInvite(chat.memberIds);
      setCallId(room.id);
    } catch { /* недоступность медиа покажет само окно звонка */ }
  };

  const counters = useNavCounters(!!user && user.role !== 'client', route.section);
  const { incoming, accept, decline } = useIncomingCalls(!!user && user.role !== 'client');
  // напоминания о встречах приходят в любой раздел: календарь для этого открывать не нужно
  useCalendarReminders(!!user && user.role !== 'client');
  const { unread } = useChatNotifications(
    !!user && user.role !== 'client',
    route.section === 'chat' && !route.view ? openChatId : null,
    () => navigate({ section: 'chat' }),
  );

  // Гость по ссылке `/meet/<токен>` — до всякой авторизации: у него нет учётной записи,
  // и экран входа на его пути означал бы «встреча только для сотрудников».
  if (guestMeetToken) return <GuestMeetPage token={guestMeetToken} />;

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

  const canManage = user.role === 'owner' || user.role === 'manager';

  return (
    <div className="shell">
      <Sidebar
        route={route}
        user={user}
        organizations={organizations}
        avatarPath={avatarPath}
        unread={unread}
        counters={counters}
        activeCall={activeCalls.length > 0 ? { participants: activeCalls[0].participants.length } : null}
        onSwitchOrg={onSwitchOrg}
        onNewTask={() => setNl({})}
        onVoiceTask={() => setNl({ voice: true })}
        onSearch={() => setPaletteOpen({})}
        onHoverSection={(section) => {
          if (section === 'focus') prefetchFocus();
          if (section === 'radar' && canManage) prefetchRadar();
        }}
        onJoinCall={joinActiveCall}
        onOpenSecretary={() => setSecretaryOpen(true)}
        onLogout={logout}
      />

      {/*
        Разделы не пересобираются при переключении: однажды открытый остаётся
        смонтированным и просто прячется. Это и есть требование ТЗ «без спиннеров» —
        доска не грузит заново проекты и задачи, чат не теряет ленту и прокрутку.
        Ключ по организации: при её смене всё содержимое обязано исчезнуть, иначе
        человек увидит данные чужой компании.
      */}
      <main className="app-main" key={user.tenantId}>
        {visited.has('focus') && (
          <Pane active={route.section === 'focus' && route.view !== 'calendar'}>
            <FocusPage
              active={route.section === 'focus'}
              onOpenTask={(projectId, taskId) => navigate({ section: 'projects', projectId, taskId })}
            />
          </Pane>
        )}
        {visited.has('projects') && (
          <Pane active={route.section === 'projects'}>
            <BoardPage
              key={boardJump.nonce}
              initial={boardJump.projectId ? { projectId: boardJump.projectId, taskId: boardJump.taskId } : undefined}
              onNavigate={(projectId, taskId) => {
                boardReported.current = { projectId: projectId ?? undefined, taskId: taskId ?? undefined };
                // Доска живёт в фоне и может доложить о себе, когда открыт другой раздел
                // или подраздел, — адрес тогда принадлежит не ей.
                const now = parsePath(window.location.pathname);
                if (now.section !== 'projects' || now.view) return;
                navigate(
                  { section: 'projects', projectId: projectId ?? undefined, taskId: taskId ?? undefined },
                  { replace: true },
                );
              }}
            />
          </Pane>
        )}
        {visited.has('chat') && (
          <Pane active={route.section === 'chat' && !route.view}>
            <ChatsPage
              onCall={callFromChat}
              onActiveChat={onActiveChat}
              initialChatId={route.chatId ?? null}
              inCall={!!callId}
            />
          </Pane>
        )}
        {/* Остальное открывают редко и ненадолго — держать это в памяти незачем */}
        {route.section === 'chat' && route.view === 'feed' && <FeedPage />}
        {route.section === 'chat' && route.view === 'meetings' && (
          <MeetingsPage onEnterGuestMeet={(roomId) => { setCallInvite([]); setCallId(roomId); }} />
        )}
        {route.section === 'focus' && route.view === 'calendar' && (
          <CalendarPage onStartCall={(roomId) => { setCallInvite([]); setCallId(roomId); }} />
        )}
        {route.section === 'radar' && canManage && <RadarPage />}
        {route.section === 'settings' && <SettingsPage route={route} role={user.role} />}
        {route.section === 'profile' && (
          <ProfilePanel onClose={() => navigate({ section: 'focus' })} onAvatar={setAvatarPath} />
        )}
      </main>

      {/* Подразделы, живущие поверх своего раздела: адрес у них свой, экран — родительский */}
      {route.section === 'focus' && route.view === 'inbox' && canManage && (
        <InboxPanel onClose={() => navigate({ section: 'focus' })} />
      )}

      <Toasts onOpenChat={(chatId) => navigate({ section: 'chat', chatId: chatId ?? undefined })} />
      {callId && <CallPanel meetingId={callId} inviteUserIds={callInvite} onClose={() => { setCallId(null); setCallInvite([]); }} />}
      {incoming && !callId && (
        <IncomingCallDialog
          call={incoming}
          onAccept={() => { const id = accept(); if (id) { setCallInvite([]); setCallId(id); } }}
          onDecline={decline}
        />
      )}
      {/* Кнопка диктовки под большим пальцем: на телефоне до Ctrl+K не дотянуться */}
      <button className="voice-fab" onClick={() => setPaletteOpen({ voice: true })} aria-label="Продиктовать">
        <Icon name="mic" size={22} />
      </button>

      {paletteOpen && (
        <CommandPalette
          role={user.role}
          autoVoice={paletteOpen.voice}
          onClose={() => setPaletteOpen(null)}
          onCreate={(opts) => setNl(opts)}
        />
      )}
      {secretaryOpen && <SecretaryPanel onClose={() => setSecretaryOpen(false)} />}
      {helpOpen && <ShortcutsHelp onClose={() => setHelpOpen(false)} />}
      {nl && <NlCommandModal onClose={() => setNl(null)} initialText={nl.text} autoRecord={nl.voice} />}
    </div>
  );
}
