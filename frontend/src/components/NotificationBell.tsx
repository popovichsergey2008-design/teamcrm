import { Icon } from './Icon';
import { badgeText, openNotificationCenter, useCenterUnread } from '../lib/notification-center';

/**
 * Колокольчик центра уведомлений (#4655) с числом непрочитанного.
 *
 * Значок лёгкий и живёт в первом экране; сам центр — отдельным куском, он грузится
 * по первому нажатию. Мест у значка несколько (левая панель, верх экрана на телефоне),
 * а число одно — из общего хранилища.
 */
export function NotificationBell({ className }: { className: string }) {
  const n = useCenterUnread();
  const label = n > 0 ? `Уведомления: непрочитанных ${n}` : 'Уведомления';
  return (
    <button className={`notif-bell ${className}`} onClick={openNotificationCenter} title={label} aria-label={label}>
      <Icon name="bell" size={18} />
      {n > 0 && <span className="notif-bell-badge" aria-hidden="true">{badgeText(n)}</span>}
    </button>
  );
}
