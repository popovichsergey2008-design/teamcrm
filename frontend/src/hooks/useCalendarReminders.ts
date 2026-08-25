import { useEffect } from 'react';
import { getSocket } from '../lib/socket';
import { showNotification, showToast } from '../lib/notifications';
import { playMessageChime } from '../lib/sound';

interface ReminderPayload {
  eventId: string;
  title: string;
  startsAt: string;
  minutesBefore: number;
  location?: string | null;
}

/** «за 15 минут», «за час», «за день» — человек читает словами, а не числом минут. */
function inWords(minutes: number): string {
  if (minutes <= 0) return 'начинается';
  if (minutes >= 1440) return `через ${Math.round(minutes / 1440)} дн.`;
  if (minutes >= 60) return `через ${Math.round(minutes / 60)} ч`;
  return `через ${minutes} мин`;
}

/**
 * Напоминания о встречах в открытом приложении.
 *
 * Письмо доходит, когда человека нет за экраном; это работает, когда он за экраном, но
 * почту не читает. Живёт в App, а не на странице календаря: напоминание нужно именно
 * тогда, когда календарь закрыт и человек занят другим.
 */
export function useCalendarReminders(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const socket = getSocket();

    const onReminder = (p: ReminderPayload) => {
      const when = new Date(p.startsAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      const body = `${when}${p.location ? ` · ${p.location}` : ''} · ${inWords(p.minutesBefore)}`;
      showToast({ title: `Встреча: ${p.title}`, body });
      showNotification(`Встреча: ${p.title}`, body);
      playMessageChime();
    };

    socket.on('calendar.reminder', onReminder);
    return () => { socket.off('calendar.reminder', onReminder); };
  }, [enabled]);
}
