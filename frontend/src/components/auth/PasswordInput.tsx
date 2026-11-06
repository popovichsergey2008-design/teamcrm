import { InputHTMLAttributes, useState } from 'react';
import { Icon } from '../Icon';

/**
 * Поле пароля со значком глаза (#4779, п. 9): вход, регистрация, вступление по
 * приглашению, сброс пароля. Стили — строкой: экран входа первый, и отдельный CSS
 * ради одной кнопки утяжелил бы его.
 */
export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [shown, setShown] = useState(false);
  return (
    <span style={{ position: 'relative', display: 'block' }}>
      <input {...props} type={shown ? 'text' : 'password'} className={props.className ?? 'input'} style={{ ...props.style, paddingRight: 40, width: '100%' }} />
      <button
        type="button" onClick={() => setShown((v) => !v)}
        aria-label={shown ? 'Скрыть пароль' : 'Показать пароль'} aria-pressed={shown} title={shown ? 'Скрыть пароль' : 'Показать пароль'}
        style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', width: 32, height: 32, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: 0, background: 'none', color: 'var(--text-mut)', cursor: 'pointer', borderRadius: 8 }}
      >
        <Icon name={shown ? 'eye-off' : 'eye'} size={16} />
      </button>
    </span>
  );
}
