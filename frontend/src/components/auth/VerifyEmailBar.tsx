import { useState } from 'react';
import { ApiError } from '../../lib/api';
import { authApi } from '../../lib/auth-api';
import '../qa-switch.css';

/**
 * Полоса «подтвердите почту» — пока новый аккаунт не открыл ссылку из письма.
 * Ленивая: у подтверждённых (почти у всех) этого кода в браузере нет.
 * Без подтверждения нельзя приглашать людей — об этом и говорим сразу.
 */
export default function VerifyEmailBar({ email, onVerified }: { email: string; onVerified: () => void }) {
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle');
  const [error, setError] = useState('');
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;

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
