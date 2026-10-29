import { FormEvent, useState } from 'react';
import { ApiError } from '../../lib/api';
import { authApi } from '../../lib/auth-api';
import { useAuth } from '../../state/auth';

/*
  Редкие шаги входа — «Забыли пароль?» и код второго фактора. Отдельным файлом и лениво:
  экран входа входит в первый экран приложения, и бюджет его сборки почти исчерпан.
*/

/** «Забыли пароль?»: письмо со ссылкой. Ответ одинаковый — есть такой адрес или нет. */
export function ForgotPasswordForm({ initialEmail, onBack }: { initialEmail: string; onBack: () => void }) {
  const [email, setEmail] = useState(initialEmail);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await authApi.forgotPassword(email.trim());
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не получилось отправить письмо');
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <>
        <p className="auth-note">
          Если адрес <b>{email.trim()}</b> зарегистрирован, письмо со ссылкой уже в пути. Ссылка действует час.
          Не видите письма — загляните в «Спам».
        </p>
        <button type="button" className="ui-btn ui-btn-primary ui-btn-md auth-submit" onClick={onBack}>Вернуться ко входу</button>
      </>
    );
  }

  return (
    <form onSubmit={submit}>
      <p className="auth-note">Пришлём на почту ссылку, по которой можно задать новый пароль.</p>
      <div className="field">
        <label htmlFor="forgot-email">Email</label>
        <input id="forgot-email" className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
      </div>
      <div className="error-text" role="alert">{error}</div>
      <button className="ui-btn ui-btn-primary ui-btn-md auth-submit" disabled={busy} type="submit">{busy ? '...' : 'Прислать ссылку'}</button>
      <p className="auth-note auth-note-dim">
        Письмо не приходит? Владелец вашей организации может выдать ссылку на смену пароля в разделе «Команда».
      </p>
      <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm auth-toggle" onClick={onBack}>Я вспомнил пароль</button>
    </form>
  );
}

/** Второй шаг входа: шесть цифр из приложения или резервный код. */
export function MfaStep() {
  const { completeMfa, cancelMfa } = useAuth();
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await completeMfa(code.trim());
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Не получилось войти';
      setError(msg);
      // время на код вышло — снова к паролю
      if (/войдите заново/i.test(msg)) setTimeout(cancelMfa, 1500);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <p className="auth-note">
        {recovery
          ? 'Введите один из резервных кодов, которые вы сохранили при включении защиты. Каждый срабатывает один раз.'
          : 'Откройте приложение-генератор (Google Authenticator, Яндекс Ключ и т. п.) и введите шесть цифр для QEVO.'}
      </p>
      <div className="field">
        <label htmlFor="mfa-code">{recovery ? 'Резервный код' : 'Код из приложения'}</label>
        <input
          id="mfa-code"
          className="input auth-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          inputMode={recovery ? 'text' : 'numeric'}
          autoComplete="one-time-code"
          placeholder={recovery ? 'abcd-efgh' : '123 456'}
          maxLength={recovery ? 12 : 7}
          required
          autoFocus
        />
      </div>
      <div className="error-text" role="alert">{error}</div>
      <button className="ui-btn ui-btn-primary ui-btn-md auth-submit" disabled={busy || !code.trim()} type="submit">{busy ? '...' : 'Войти'}</button>
      <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm auth-toggle" onClick={() => { setRecovery(!recovery); setCode(''); setError(''); }}>
        {recovery ? 'Ввести код из приложения' : 'Нет телефона? Резервный код'}
      </button>
      <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm auth-toggle" onClick={cancelMfa}>Войти под другим аккаунтом</button>
    </form>
  );
}
