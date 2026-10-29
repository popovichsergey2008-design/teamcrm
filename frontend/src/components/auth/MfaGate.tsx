import { Logo } from '../Logo';
import { refreshAccess } from '../../lib/api';
import MfaSettings from './MfaSettings';

/**
 * Организация требует вход по коду (Настройки → Безопасность), а у человека он не включён.
 * Сервер в таком состоянии пускает только к настройке защиты — так и показываем: один экран.
 * Включил — берём новый токен (уже без ограничения) и открываем приложение заново.
 */
export default function MfaGate({ onLogout }: { onLogout: () => void }) {
  const done = async () => {
    await refreshAccess().catch(() => undefined);
    window.location.reload();
  };
  return (
    <div className="center-screen">
      <div className="card auth-card">
        <div className="auth-logo">
          <Logo size={64} />
          <span className="logo-word">QEVO</span>
        </div>
        <p className="auth-note">
          В вашей организации обязателен вход по коду из приложения. Включите его — это займёт минуту,
          и дальше QEVO откроется как обычно.
        </p>
        <MfaSettings onEnabled={done} />
        <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm auth-toggle" onClick={onLogout}>Выйти</button>
      </div>
    </div>
  );
}
