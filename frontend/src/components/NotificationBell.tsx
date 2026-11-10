import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { badgeText, openNotificationCenter } from '../lib/notification-center';

type Count = { n: number; decisions: number; tip: string };

/**
 * Колокольчик в шапке телефона: ведёт во «Входящие» (#4807) и показывает ТО ЖЕ число,
 * что пункт «Входящие» в меню, — непрочитанное важное и решения, которые ждут вас.
 *
 * До 10.11 число бралось из старого центра уведомлений, где считались и обычные
 * сообщения чатов: в шапке горело «7», а во «Входящих» — «1». Число считает меню
 * (Sidebar) и сообщает сюда событием `qevo:inbox-count`; жёлтое — если ждут решения.
 */
export function NotificationBell({ className }: { className: string }) {
  const [c, setC] = useState<Count | null>(() => (window as Window & { __qevoInbox?: Count }).__qevoInbox ?? null);
  useEffect(() => {
    const on = (e: Event) => setC((e as CustomEvent<Count>).detail);
    window.addEventListener('qevo:inbox-count', on);
    return () => window.removeEventListener('qevo:inbox-count', on);
  }, []);
  const n = c?.n ?? 0;
  const label = n > 0 ? `Входящие: ${c?.tip || `непрочитанных ${n}`}` : 'Входящие';
  return (
    <button className={`notif-bell ${className}`} onClick={openNotificationCenter} title={label} aria-label={label}>
      <Icon name="bell" size={18} />
      {n > 0 && <span className={`notif-bell-badge${c?.decisions ? ' is-warn' : ''}`} aria-hidden="true">{badgeText(n)}</span>}
    </button>
  );
}
