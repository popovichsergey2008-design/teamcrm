import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { Logo } from '../components/Logo';
import { ApiError } from '../lib/api';
import { authApi } from '../lib/auth-api';

/** Подтверждение почты по ссылке из письма (/?verify=<token>). Ссылка одноразовая. */
export function VerifyEmailPage({ token }: { token: string }) {
  const [state, setState] = useState<{ done?: string; error?: string }>({});
  const once = useRef(false);

  useEffect(() => {
    if (once.current) return; // StrictMode зовёт эффект дважды — ссылка сгорела бы на первом
    once.current = true;
    authApi.verifyEmail(token)
      .then((r) => setState({ done: r.email }))
      .catch((e) => setState({ error: e instanceof ApiError ? e.message : 'Ссылка недействительна' }));
  }, [token]);

  return (
    <div className="center-screen">
      <div className="card auth-card">
        <div className="auth-logo">
          <Logo size={88} />
          <span className="logo-word">QEVO</span>
        </div>
        <p className="dim auth-sub">Подтверждение почты</p>
        {state.done ? (
          <div className="pnl-good" style={{ marginBottom: 14 }}><Icon name="check-circle" size={15} /> Почта {state.done} подтверждена.</div>
        ) : state.error ? (
          <div className="error-text">{state.error}</div>
        ) : (
          <div className="spinner" />
        )}
        <a className="ui-btn ui-btn-primary ui-btn-md auth-submit" href="/">Открыть QEVO</a>
      </div>
    </div>
  );
}
