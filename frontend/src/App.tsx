import { useEffect, useState } from 'react';
import { useAuth } from './state/auth';
import { api, ApiError } from './lib/api';
import { LoginPage } from './pages/LoginPage';
import { BoardPage } from './pages/BoardPage';
import { AcceptInvitePage } from './pages/AcceptInvitePage';
import { ProfilePanel } from './components/ProfilePanel';

export function App() {
  const { user, loading, logout } = useAuth();
  const [tgCode, setTgCode] = useState<string | null>(null);
  const [showProfile, setShowProfile] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  // приглашение в команду: ссылка вида /?invite=<token>
  const inviteToken = new URLSearchParams(window.location.search).get('invite');

  useEffect(() => {
    if (user) api.me().then((m) => setAvatarUrl(m.avatarUrl)).catch(() => undefined);
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
          {tgCode && (
            <span className="badge" title="Отправьте код Telegram-боту для привязки">
              TG-код: <b>{tgCode}</b>
            </span>
          )}
          <button className="btn btn-ghost btn-sm" onClick={linkTelegram}>
            Привязать Telegram
          </button>
          <button className="profile-btn" onClick={() => setShowProfile(true)} title="Личный кабинет">
            {avatarUrl ? <img className="avatar-sm" src={avatarUrl} alt="" /> : <span className="avatar-sm avatar-ph">{user.fullName?.[0] ?? '?'}</span>}
            <span className="dim">{user.fullName}</span>
          </button>
          <span className="badge badge-role">{user.role}</span>
          <button className="btn btn-ghost btn-sm" onClick={logout}>
            Выйти
          </button>
        </div>
      </header>
      <BoardPage />
      {showProfile && <ProfilePanel onClose={() => setShowProfile(false)} onAvatar={setAvatarUrl} />}
    </div>
  );
}
