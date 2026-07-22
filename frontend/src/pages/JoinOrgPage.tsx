import { FormEvent, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { roleLabel } from '../lib/labels';

/** Вступление в организацию по многоразовой ссылке (/?join=<token>): человек вводит свой e-mail/имя/пароль. */
export function JoinOrgPage({ token }: { token: string }) {
  const [info, setInfo] = useState<{ tenantName: string; role: string } | null>(null);
  const [invalid, setInvalid] = useState('');
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.inviteLinkInfo(token)
      .then(setInfo)
      .catch((e) => setInvalid(e instanceof ApiError ? e.message : 'Ссылка недействительна'));
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.acceptInviteLink({ token, email, fullName, password });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось вступить');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-screen">
      <form className="card auth-card" onSubmit={submit}>
        <div className="brand auth-brand">TEAM<span>CRM</span></div>
        <p className="dim auth-sub">
          {info ? <>Вступление в «{info.tenantName}» · роль: {roleLabel(info.role)}</> : 'Вступление в организацию'}
        </p>
        {invalid ? (
          <div className="error-text">{invalid}</div>
        ) : done ? (
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
              <label>E-mail</label>
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="field">
              <label>Пароль</label>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
            </div>
            <div className="error-text">{error}</div>
            <button className="btn btn-primary auth-submit" disabled={busy || !info} type="submit">
              {busy ? '...' : 'Вступить и создать аккаунт'}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
