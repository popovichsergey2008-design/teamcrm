import { useState } from 'react';
import { leaveQa } from '../lib/qa-switch';
import './qa-switch.css';

/**
 * #1562: полоса сверху, пока вошли как тестовый сотрудник. Ленивая: у всех, кроме
 * тех, кто переключился, этого кода в браузере нет вовсе.
 */
export default function QaSwitchBar({ name }: { name: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const back = async () => {
    setBusy(true); setError('');
    try { await leaveQa(); } catch (e) { setError((e as Error).message || 'Не удалось вернуться'); setBusy(false); }
  };
  return (
    <div className="qa-bar" role="status">
      <span className="qa-bar-text">Вы вошли как {name} (тестовый сотрудник)</span>
      <button type="button" className="qa-bar-back" onClick={back} disabled={busy}>
        {busy ? 'Возвращаем…' : 'Вернуться в свой аккаунт'}
      </button>
      {error && <span className="qa-bar-error">{error}</span>}
    </div>
  );
}
