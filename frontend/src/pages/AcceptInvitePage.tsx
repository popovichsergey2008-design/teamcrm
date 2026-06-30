import { FormEvent, useState } from 'react';
import { api, ApiError } from '../lib/api';

export function AcceptInvitePage({ token }: { token: string }) {
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.acceptInvite({ token, fullName, password });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось принять приглашение');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-screen">
      <form className="card auth-card" onSubmit={submit}>
        <div className="brand auth-brand">TEAM<span>CRM</span></div>
        <p className="dim auth-sub">Принятие приглашения в команду</p>
        {done ? (
          <>
            <div className="pnl-good" style={{ marginBottom: 14 }}>✅ Аккаунт создан. Теперь войдите.</div>
            <a className="btn btn-primary auth-submit" href="/">Перейти ко входу</a>
          </>
        ) : (
          <>
            <div className="field">
              <label>Ваше имя</label>
              <input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
            </div>
            <div className="field">
              <label>Пароль</label>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
            </div>
            <div className="error-text">{error}</div>
            <button className="btn btn-primary auth-submit" disabled={busy} type="submit">
              {busy ? '...' : 'Принять и создать аккаунт'}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
