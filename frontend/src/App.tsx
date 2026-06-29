import { useAuth } from './state/auth';
import { LoginPage } from './pages/LoginPage';
import { BoardPage } from './pages/BoardPage';

export function App() {
  const { user, loading, logout } = useAuth();

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
          <span className="dim">{user.fullName}</span>
          <span className="badge badge-role">{user.role}</span>
          <button className="btn btn-ghost btn-sm" onClick={logout}>
            Выйти
          </button>
        </div>
      </header>
      <BoardPage />
    </div>
  );
}
