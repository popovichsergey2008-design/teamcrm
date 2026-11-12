import { useEffect } from 'react';
import { getSocket } from '../lib/socket';
import { showNotification, showToast } from '../lib/notifications';
import { playMessageChime } from '../lib/sound';
import { openInboxItem } from './useMobileInbox';

interface ReminderPayload {
  eventId: string;
  title: string;
  startsAt: string;
  minutesBefore: number;
  location?: string | null;
  /** Встреча с созвоном: всплывашка ведёт на её страницу, где и войти (ТЗ-14). */
  publicId?: string | null;
  /** #4892, п. 6: короткая подготовка — первые пункты повестки. */
  prep?: string | null;
}

/** «за 15 минут», «за час», «за день» — человек читает словами, а не числом минут. */
function inWords(minutes: number): string {
  if (minutes <= 0) return 'начинается сейчас'; // #4766: напоминание в момент начала
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
      const body = `${when}${p.location ? ` · ${p.location}` : ''} · ${inWords(p.minutesBefore)}${p.prep ? ` · ${p.prep}` : ''}`;
      const path = p.publicId ? `/meet/${p.publicId}` : undefined;
      // #4749: висит до начала встречи (или пока не нажмут), следующее напоминание её заменяет
      const keep = { expireAt: new Date(p.startsAt).getTime(), replaceKey: `cal:${p.eventId}` };
      showToast(path
        ? { title: `Встреча: ${p.title}`, body: `${body} · нажмите, чтобы войти`, section: 'inbox', inboxPath: path, ...keep }
        : { title: `Встреча: ${p.title}`, body, ...keep });
      showNotification(`Встреча: ${p.title}`, body, path ? () => openInboxItem(undefined, path) : undefined);
      playMessageChime();
    };

    // повестку встречи организатор отправил по кнопке (#4892, п. 6)
    const onAgenda = (p: { title: string; body: string }) => showToast({ title: `Повестка: ${p.title}`, body: p.body.split(String.fromCharCode(10)).slice(0, 3).join(' · ') });
    socket.on('calendar.reminder', onReminder);
    socket.on('calendar.agenda', onAgenda);
    return () => { socket.off('calendar.reminder', onReminder); socket.off('calendar.agenda', onAgenda); };
  }, [enabled]);
}
