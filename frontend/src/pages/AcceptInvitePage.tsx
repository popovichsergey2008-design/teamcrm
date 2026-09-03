import { FormEvent, useState } from 'react';
import { Icon } from '../components/Icon';
import { Logo } from '../components/Logo';
import { api, ApiError } from '../lib/api';

export function AcceptInvitePage({ token }: { token: string }) {
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ usedExistingAccount: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const r = await api.acceptInvite({ token, fullName, password });
      setDone({ usedExistingAccount: !!r?.usedExistingAccount });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось принять приглашение');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-screen">
      <form className="card auth-card" onSubmit={submit}>
        {/* Первое, что видит человек. Знак крупнее слова — его и запоминают. */}
        <div className="auth-logo">
          <Logo size={56} />
          <span className="logo-word">ANTHILL<span className="logo-dot">.</span>TEAM</span>
        </div>
        <p className="dim auth-sub">Принятие приглашения в команду</p>
        {done ? (
          <>
            {done.usedExistingAccount ? (
              // пароль существующего аккаунта не меняем — иначе по ссылке-приглашению
              // можно было бы сменить пароль чужому человеку
              <div className="pnl-good" style={{ marginBottom: 14 }}>
                <Icon name="check-circle" size={15} /> Вы добавлены в организацию.<br />
                У вас уже был аккаунт с этим e-mail, поэтому <b>введённый сейчас пароль не применён</b> — входите своим прежним.
                Забыли его — попросите владельца выдать ссылку на смену пароля.
              </div>
            ) : (
              <div className="pnl-good" style={{ marginBottom: 14 }}><Icon name="check-circle" size={15} /> Аккаунт создан. Теперь войдите.</div>
            )}
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
