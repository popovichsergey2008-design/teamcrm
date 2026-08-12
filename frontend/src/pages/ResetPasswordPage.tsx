import { FormEvent, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';

/**
 * Задание нового пароля по одноразовой ссылке (/?reset=<token>).
 * Ссылку выдаёт владелец организации; пароль человек придумывает сам — владелец его не видит.
 */
export function ResetPasswordPage({ token }: { token: string }) {
  const [info, setInfo] = useState<{ email: string; fullName: string } | null>(null);
  const [invalid, setInvalid] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.passwordResetInfo(token)
      .then(setInfo)
      .catch((e) => setInvalid(e instanceof ApiError ? e.message : 'Ссылка недействительна'));
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (password !== repeat) return setError('Пароли не совпадают');
    setBusy(true);
    try {
      await api.resetPassword({ token, password });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сменить пароль');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-screen">
      <form className="card auth-card" onSubmit={submit}>
        <div className="brand auth-brand">TEAM<span>CRM</span></div>
        <p className="dim auth-sub">
          {info ? <>Новый пароль для {info.email}</> : 'Смена пароля'}
        </p>
        {invalid ? (
          <div className="error-text">{invalid}</div>
        ) : done ? (
          <>
            <div className="pnl-good" style={{ marginBottom: 14 }}>✅ Пароль изменён. Теперь войдите с новым паролем.</div>
            <a className="btn btn-primary auth-submit" href="/">Перейти ко входу</a>
          </>
        ) : (
          <>
            <div className="field">
              <label>Новый пароль</label>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoFocus />
            </div>
            <div className="field">
              <label>Повторите пароль</label>
              <input className="input" type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required minLength={8} />
            </div>
            <div className="dim" style={{ fontSize: 12, marginBottom: 8 }}>
              Не короче 8 символов. После смены все ваши сеансы на других устройствах будут завершены.
            </div>
            <div className="error-text">{error}</div>
            <button className="btn btn-primary auth-submit" disabled={busy || !info} type="submit">
              {busy ? '...' : 'Сменить пароль'}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
