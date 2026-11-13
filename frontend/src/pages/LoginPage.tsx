import { FormEvent, useState } from 'react';
import { authNotice, useAuth } from '../state/auth';
import { Logo } from '../components/Logo';
import { ApiError } from '../lib/api';
import { SocialButtons } from '../components/SocialButtons';
import { lazyComponent } from '../lib/lazy';
import { PasswordInput } from '../components/auth/PasswordInput';
import { signupMode, signupReferralCode, signupReferrer, signupUtm } from '../lib/signup-intent';
// галочки согласий нужны только при регистрации — первый экран входа без них легче (#4680)
const PolicyCheck = lazyComponent(() => import('../components/legal/PolicyCheck').then((m) => m.PolicyCheck));
// «Забыли пароль?» и код второго фактора нужны редко — тоже лениво
const ForgotPasswordForm = lazyComponent(() => import('../components/auth/AuthSteps').then((m) => m.ForgotPasswordForm));
const MfaStep = lazyComponent(() => import('../components/auth/AuthSteps').then((m) => m.MfaStep));

export function LoginPage() {
  const { login, register, mfaPending } = useAuth();
  // #4779: кнопка «Регистрация» на сайте ведёт сразу в регистрацию, «Войти» — во вход
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>(signupMode ?? 'login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  /** Поле-ловушка для ботов: скрыто от людей, бот заполняет его вместе со всеми. */
  const [website, setWebsite] = useState('');
  /** #4675: согласие с Политикой конфиденциальности — только для регистрации. */
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState(authNotice);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'login') await login(email, password);
      // #4779: имя и название пространства — после входа, здесь только почта и согласия
      else await register({ email, password, acceptPrivacy: agreed, website, utm: signupUtm(), referrerHost: signupReferrer(), referralCode: signupReferralCode() });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Что-то пошло не так');
    } finally {
      setBusy(false);
    }
  }

  const head = (sub: string) => (
    <>
      {/* Первое, что видит человек. Знак крупнее слова — его и запоминают. */}
      <div className="auth-logo">
        <Logo size={88} />
        <span className="logo-word">QEVO</span>
      </div>
      <p className="dim auth-sub">{sub}</p>
    </>
  );

  if (mfaPending || mode === 'forgot') {
    return (
      <div className="center-screen">
        <div className="card auth-card">
          {head(mfaPending ? 'Подтвердите вход' : 'Смена пароля')}
          {mfaPending
            ? <MfaStep />
            : <ForgotPasswordForm initialEmail={email} onBack={() => { setMode('login'); setError(''); }} />}
        </div>
      </div>
    );
  }

  return (
    <div className="center-screen">
      <form className="card auth-card" onSubmit={submit}>
        {head(mode === 'login' ? 'Вход в систему' : 'Регистрация и создание пространства')}

        {mode === 'register' && (
          <input
            className="auth-trap" tabIndex={-1} autoComplete="off" aria-hidden="true"
            name="website" value={website} onChange={(e) => setWebsite(e.target.value)}
          />
        )}

        <div className="field">
          <label>Email</label>
          <input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="field">
          <label>Пароль</label>
          <PasswordInput
            className="input"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
          {mode === 'register' && (
            <span className="dim" style={{ fontSize: 12 }}>Не короче 8 символов. Лучше фраза из нескольких слов, чем «Qwerty1!».</span>
          )}
        </div>

        {mode === 'register' && <PolicyCheck checked={agreed} onChange={setAgreed} />}

        <div className="error-text">{error}</div>

        {/* #4778, дословно: как на сайте — 14 дней */}
        {mode === 'register' && <p className="dim" style={{ fontSize: 13, margin: '0 0 8px' }}>14 дней бесплатно</p>}

        <button className="ui-btn ui-btn-primary ui-btn-md auth-submit" disabled={busy || (mode === 'register' && !agreed)} type="submit">
          {busy ? '...' : mode === 'login' ? 'Войти' : 'Создать'}
        </button>

        {/* Кнопки провайдеров появятся, только когда на сервере будут ключи. */}
        <SocialButtons acceptPrivacy={agreed} onAcceptPrivacy={setAgreed} />

        {mode === 'login' && (
          <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm auth-toggle" onClick={() => { setMode('forgot'); setError(''); }}>
            Забыли пароль?
          </button>
        )}

        <button
          type="button"
          className="ui-btn ui-btn-ghost ui-btn-sm auth-toggle"
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login');
            setError('');
          }}
        >
          {mode === 'login' ? 'Создать новое пространство' : 'У меня уже есть аккаунт'}
        </button>
      </form>
    </div>
  );
}
