import { FormEvent, lazy, Suspense, useEffect, useState } from 'react';
import qrcode from 'qrcode-generator';
import { APP, Me, pc, pcPublic, PcError, setTokens, signedIn, signOut } from './api';

const OwnerConsole = lazy(() => import('./OwnerConsole'));
const DevConsole = lazy(() => import('./DevConsole'));

const TITLE = { owner: 'Консоль владельца', developer: 'Консоль разработчика', support: 'Консоль поддержки' } as const;
const ROLE_LABEL = { owner: 'Владелец платформы', developer: 'Разработчик', support: 'Поддержка' } as const;

type Tokens = { accessToken: string; refreshToken: string };
type LoginRes = Tokens | { needCode: true } | { mfaSetup: string };

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(!signedIn());

  useEffect(() => {
    document.title = `${TITLE[APP]} · QEVO`;
    const out = () => setMe(null);
    window.addEventListener('pc:signed-out', out);
    if (signedIn()) pc<Me>('GET', '/pc/me').then(setMe).catch(() => setTokens(null)).finally(() => setReady(true));
    return () => window.removeEventListener('pc:signed-out', out);
  }, []);

  if (!ready) return <div className="pc-center dim">Загрузка…</div>;
  if (!me) return <AuthScreen onIn={() => pc<Me>('GET', '/pc/me').then(setMe)} />;

  return (
    <div className="pc-shell">
      <header className="pc-top">
        <div className="pc-brand"><b>QEVO</b> <span>{TITLE[APP]}</span></div>
        <div className="pc-top-right">
          <span className="pc-env">production</span>
          <span className="dim">{me.name}</span>
          <button type="button" className="pc-btn pc-btn-ghost" onClick={() => void signOut()}>Выйти</button>
        </div>
      </header>
      <main className="pc-main">
        <Suspense fallback={<div className="dim">Загрузка…</div>}>
          {APP === 'owner' && <OwnerConsole me={me} />}
          {APP === 'developer' && <DevConsole canTriage={me.perms.includes('dev.triage')} />}
          {APP === 'support' && (
            <section className="pc-card">
              <h2>Консоль поддержки</h2>
              <p>Обращения пока работают на прежнем адресе — <a href="https://console.qevo.one">console.qevo.one</a>. Переезд сюда — следующий этап.</p>
            </section>
          )}
        </Suspense>
      </main>
    </div>
  );
}

function AuthScreen({ onIn }: { onIn: () => Promise<unknown> }) {
  const [mode, setMode] = useState<'login' | 'register' | 'code' | 'setup' | 'sent'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [secret, setSecret] = useState<{ secret: string; uri: string } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [registered, setRegistered] = useState<'active' | 'pending' | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setErr(''); setBusy(true);
    try { await fn(); } catch (e) { setErr(e instanceof PcError ? e.message : 'Не получилось'); } finally { setBusy(false); }
  };

  const finish = async (r: LoginRes) => {
    if ('accessToken' in r) { setTokens(r); await onIn(); return; }
    if ('needCode' in r) { setMode('code'); return; }
    setSetupToken(r.mfaSetup);
    setSecret(await pcPublic<{ secret: string; uri: string }>('/pc/auth/mfa/setup', { token: r.mfaSetup }));
    setMode('setup');
  };

  const login = (e: FormEvent) => { e.preventDefault(); void run(async () => finish(await pcPublic<LoginRes>('/pc/auth/login', { email, password, app: APP, code: mode === 'code' ? code : undefined }))); };
  const register = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await pcPublic<{ status: 'active' | 'pending' }>('/pc/auth/register', { email, password, name, role: APP });
      setRegistered(r.status); setMode('sent');
    });
  };
  const enable = (e: FormEvent) => { e.preventDefault(); void run(async () => finish(await pcPublic<Tokens>('/pc/auth/mfa/enable', { token: setupToken, code }))); };

  return (
    <div className="pc-center">
      <div className="pc-card pc-auth">
        <div className="pc-brand pc-auth-brand"><b>QEVO</b> <span>{TITLE[APP]}</span></div>

        {(mode === 'login' || mode === 'code') && (
          <form onSubmit={login}>
            <h1>Вход</h1>
            <label>Почта<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required disabled={mode === 'code'} /></label>
            <label>Пароль<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required disabled={mode === 'code'} /></label>
            {mode === 'code' && (
              <label>Код из приложения-аутентификатора
                <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus required maxLength={8} />
              </label>
            )}
            {err && <p className="pc-err" role="alert">{err}</p>}
            <button className="pc-btn" disabled={busy}>{mode === 'code' ? 'Подтвердить' : 'Войти'}</button>
            <p className="dim pc-switch">Нет доступа? <button type="button" className="pc-link" onClick={() => { setErr(''); setMode('register'); }}>Подать заявку</button></p>
          </form>
        )}

        {mode === 'register' && (
          <form onSubmit={register}>
            <h1>Заявка на доступ</h1>
            <p className="dim">Роль: <b>{ROLE_LABEL[APP]}</b>. Это отдельная учётная запись — не та, что в CRM. Доступ откроет владелец платформы.</p>
            <label>Имя и фамилия<input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} /></label>
            <label>Почта<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
            <label>Пароль<input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} /></label>
            {APP === 'owner' && <p className="dim pc-hint">Владелец компании QEVO в CRM: укажите ту же почту и тот же пароль, что в CRM, — доступ откроется сразу.</p>}
            {err && <p className="pc-err" role="alert">{err}</p>}
            <button className="pc-btn" disabled={busy}>Отправить заявку</button>
            <p className="dim pc-switch"><button type="button" className="pc-link" onClick={() => { setErr(''); setMode('login'); }}>Уже есть доступ — войти</button></p>
          </form>
        )}

        {mode === 'sent' && (
          <div>
            <h1>{registered === 'active' ? 'Доступ открыт' : 'Заявка отправлена'}</h1>
            <p>{registered === 'active'
              ? 'Войдите и настройте код второго шага — без него консоль не откроется.'
              : 'Когда владелец платформы одобрит заявку, войдите с этой почтой и паролем. При первом входе настроите код второго шага.'}</p>
            <button className="pc-btn" onClick={() => setMode('login')}>Ко входу</button>
          </div>
        )}

        {mode === 'setup' && secret && (
          <form onSubmit={enable}>
            <h1>Код второго шага</h1>
            <p className="dim">Обязателен для всех сотрудников платформы. Отсканируйте QR в Google Authenticator, Яндекс Ключе или похожем приложении и введите шесть цифр.</p>
            <Qr text={secret.uri} />
            <p className="dim pc-secret">Ключ вручную: <code>{secret.secret}</code></p>
            <label>Код<input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required maxLength={8} autoFocus /></label>
            {err && <p className="pc-err" role="alert">{err}</p>}
            <button className="pc-btn" disabled={busy}>Включить и войти</button>
          </form>
        )}
      </div>
    </div>
  );
}

function Qr({ text }: { text: string }) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  const pad = 4;
  const size = n + pad * 2;
  const dark: [number, number][] = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) dark.push([c, r]);
  // тёмные модули на белом: сканеры не любят инверсию, даже в тёмной теме
  return (
    <svg className="pc-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="QR-код для приложения-аутентификатора">
      <rect width={size} height={size} fill="#fff" />
      {dark.map(([x, y]) => <rect key={`${x}-${y}`} x={x + pad} y={y + pad} width={1.02} height={1.02} fill="#000" />)}
    </svg>
  );
}
