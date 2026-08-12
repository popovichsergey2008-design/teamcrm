import { FormEvent, useState } from 'react';
import { useAuth } from '../state/auth';
import { ApiError } from '../lib/api';

export function LoginPage() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tenantName, setTenantName] = useState('');
  const [fullName, setFullName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'login') await login(email, password);
      else await register({ tenantName, email, password, fullName });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Что-то пошло не так');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-screen">
      <form className="card auth-card" onSubmit={submit}>
        <div className="brand auth-brand">
          TEAM<span>CRM</span>
        </div>
        <p className="dim auth-sub">
          {mode === 'login' ? 'Вход в систему' : 'Регистрация организации'}
        </p>

        {mode === 'register' && (
          <>
            <div className="field">
              <label>Организация</label>
              <input className="input" value={tenantName} onChange={(e) => setTenantName(e.target.value)} required />
            </div>
            <div className="field">
              <label>Ваше имя</label>
              <input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
            </div>
          </>
        )}

        <div className="field">
          <label>E-mail</label>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="field">
          <label>Пароль</label>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
        </div>

        <div className="error-text">{error}</div>

        <button className="btn btn-primary auth-submit" disabled={busy} type="submit">
          {busy ? '...' : mode === 'login' ? 'Войти' : 'Создать'}
        </button>

        {/* писем система не шлёт, поэтому честно: ссылку на смену пароля выдаёт владелец */}
        {mode === 'login' && (
          <div className="dim" style={{ fontSize: 12, marginTop: 10, textAlign: 'center' }}>
            Забыли пароль? Попросите владельца организации — в разделе «Команда» он выдаст вам ссылку на смену пароля.
          </div>
        )}

        <button
          type="button"
          className="btn btn-ghost btn-sm auth-toggle"
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login');
            setError('');
          }}
        >
          {mode === 'login' ? 'Создать новую организацию' : 'У меня уже есть аккаунт'}
        </button>
      </form>
    </div>
  );
}
