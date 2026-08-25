import { useEffect, useRef } from 'react';
import { getSocket } from '../lib/socket';
import { showNotification, showToast } from '../lib/notifications';
import { notifyAgendaArrived } from '../components/MeetingAgenda';

interface AgendaPayload {
  eventId: string;
  title: string;
  startsAt: string;
  body: string;
}

interface ResultPayload {
  meetingId: string;
  title: string;
  summary: string;
  decisions: number;
  created: number;
  pending: number;
  /** Задачи, записанные лично на этого человека. */
  mine: string[];
}

/** «3 задачи» / «1 задача» — на счётчике видно каждый раз, и ошибка режет глаз. */
function tasksWord(n: number): string {
  const tail = n % 10;
  const teen = n % 100 >= 11 && n % 100 <= 14;
  if (!teen && tail === 1) return `${n} задача`;
  if (!teen && tail >= 2 && tail <= 4) return `${n} задачи`;
  return `${n} задач`;
}

/**
 * Модератор встреч на стороне человека: повестка до и итог после.
 *
 * Живёт в App, а не в календаре: повестка нужна тому, кто занят другим и вот-вот
 * опоздает на встречу, а итог разбора — тому, кто со встречи уже вышел.
 */
export function useMeetingModerator(enabled: boolean, onOpenFocus: () => void, onOpenMeetings: () => void): void {
  const focus = useRef(onOpenFocus);
  const meetings = useRef(onOpenMeetings);
  useEffect(() => { focus.current = onOpenFocus; meetings.current = onOpenMeetings; }, [onOpenFocus, onOpenMeetings]);

  useEffect(() => {
    if (!enabled) return;
    const socket = getSocket();

    const onAgenda = (p: AgendaPayload) => {
      const first = p.body.split('\n')[0] ?? '';
      showToast({ title: `Через 5 минут: ${p.title}`, body: first, section: 'focus' });
      showNotification(`Через 5 минут: ${p.title}`, first, () => focus.current());
      notifyAgendaArrived();
    };

    const onResult = (p: ResultPayload) => {
      // Своё называем поимённо: «встреча разобрана» без «что записано на меня»
      // человек прочитает один раз и перестанет открывать.
      const body = p.mine.length
        ? `На вас: ${p.mine.slice(0, 3).join('; ')}`
        : `${p.decisions} решений, ${tasksWord(p.created)} создано, черновиков ${p.pending}`;
      showToast({ title: `Встреча разобрана: ${p.title}`, body, section: 'meetings' });
      showNotification(`Встреча разобрана: ${p.title}`, body, () => meetings.current());
    };

    socket.on('assistant.agenda', onAgenda);
    socket.on('assistant.meeting-result', onResult);
    return () => {
      socket.off('assistant.agenda', onAgenda);
      socket.off('assistant.meeting-result', onResult);
    };
  }, [enabled]);
}
