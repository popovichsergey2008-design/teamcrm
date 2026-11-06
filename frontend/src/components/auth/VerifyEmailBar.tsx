import { FormEvent, useState } from 'react';
import { ApiError } from '../../lib/api';
import { authApi } from '../../lib/auth-api';
import '../qa-switch.css';

/**
 * Полоса «подтвердите почту» — пока новый аккаунт не открыл ссылку из письма.
 * Ленивая: у подтверждённых (почти у всех) этого кода в браузере нет.
 * Без подтверждения нельзя приглашать людей — об этом и говорим сразу.
 */
export default function VerifyEmailBar({ email: initial, onVerified }: { email: string; onVerified: () => void }) {
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle');
  const [error, setError] = useState('');
  const [hidden, setHidden] = useState(false);
  const [email, setEmail] = useState(initial);
  const [draft, setDraft] = useState('');
  if (hidden) return null;

  /*
    #4779, п. 8: зарегистрировался через Telegram — адрес служебный (tg…@users.qevo.one),
    ящика за ним нет, и «подтвердите почту» вело в никуда. Просим свою — прямо здесь.
  */
  if (/@users\.qevo\.one$/i.test(email)) {
    const save = async (e: FormEvent) => {
      e.preventDefault();
      setState('busy'); setError('');
      try {
        const r = await authApi.setEmail(draft.trim());
        setEmail(r.email);
        setState('sent');
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Не получилось сохранить');
        setState('idle');
      }
    };
    return (
      <form className="qa-bar" role="status" onSubmit={save}>
        <span className="qa-bar-text">Укажите свою почту, чтобы приглашать сотрудников.</span>
        <input className="input" type="email" required value={draft} onChange={(e) => setDraft(e.target.value)}
          placeholder="name@company.ru" aria-label="Ваша почта" autoComplete="email" style={{ maxWidth: 240, height: 30 }} />
        <button type="submit" className="qa-bar-back" disabled={state === 'busy'}>{state === 'busy' ? 'Сохраняем…' : 'Сохранить'}</button>
        <button type="button" className="qa-bar-back" onClick={() => setHidden(true)} aria-label="Скрыть до следующего входа">Позже</button>
        {error && <span className="qa-bar-error">{error}</span>}
      </form>
    );
  }

  const resend = async () => {
    setState('busy'); setError('');
    try {
      const r = await authApi.resendVerification();
      if (r.verified) onVerified();
      else setState('sent');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не получилось отправить');
      setState('idle');
    }
  };

  return (
    <div className="qa-bar" role="status">
      <span className="qa-bar-text">
        {state === 'sent'
          ? `Отправили новое письмо на ${email}. Откройте ссылку из него — и всё.`
          : `Подтвердите почту ${email}: мы отправили письмо со ссылкой. Без этого нельзя приглашать сотрудников.`}
      </span>
      {state !== 'sent' && (
        <button type="button" className="qa-bar-back" onClick={resend} disabled={state === 'busy'}>
          {state === 'busy' ? 'Отправляем…' : 'Отправить ещё раз'}
        </button>
      )}
      <button type="button" className="qa-bar-back" onClick={() => setHidden(true)} aria-label="Скрыть до следующего входа">Позже</button>
      {error && <span className="qa-bar-error">{error}</span>}
    </div>
  );
}
