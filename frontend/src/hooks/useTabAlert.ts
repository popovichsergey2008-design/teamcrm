import { useEffect, useRef } from 'react';
import { getSocket } from '../lib/socket';
import { playTaskChime } from '../lib/sound';
import { showToast } from '../lib/notifications';
import { AlertCounters, flashTab, stopTabAlert, tabAlertMessage } from '../lib/tab-alert';
import { NavCounters } from './useNavCounters';

/**
 * Мигающий заголовок вкладки: «появилось что-то новое».
 *
 * Заказчик: «в YouGile заголовок вкладки начинает мигать, у нас такого не видел».
 * Смысл ровно в этом — человек весь день сидит в другой вкладке, и о новой задаче
 * узнаёт, только вернувшись в CRM.
 *
 * Два источника, и оба нужны:
 * — событие `task.for_you` прилетает мгновенно, но только про новые задачи;
 * — счётчики панели ловят всё остальное (объявления, приглашения, решения), но
 *   опрашиваются раз в минуту, а в фоновой вкладке браузер режет таймеры и того
 *   сильнее. Ждать этого для главного случая — новой задачи — нельзя.
 */
export function useTabAlert(enabled: boolean, counters: NavCounters, chatUnread: number): void {
  const prev = useRef<AlertCounters | null>(null);

  useEffect(() => {
    if (!enabled) { prev.current = null; stopTabAlert(); return; }
    const next: AlertCounters = {
      tasks: counters.tasks?.unread ?? 0,
      news: counters.news?.unread ?? 0,
      calendar: counters.calendar?.pending ?? 0,
      decide: counters.focus?.decide ?? 0,
      chats: chatUnread,
    };
    const message = tabAlertMessage(prev.current, next);
    prev.current = next;
    if (message) flashTab(message);
  }, [enabled, counters, chatUnread]);

  useEffect(() => {
    if (!enabled) return;
    const socket = getSocket();
    const onForYou = (p: { title?: string; taskId?: string; projectId?: string }) => {
      flashTab('Новая задача');
      /*
        Звук — отдельно от мигания вкладки.

        Заголовок мигает для того, кто сидит в другой вкладке; звук нужен тому, кто
        сидит в самой CRM и смотрит в другое место экрана. Сигнал свой, не такой, как
        у сообщения: по звуку должно быть понятно, что случилось, не глядя на экран.
      */
      playTaskChime();
      showToast({
        title: 'Новая задача на вас',
        body: p?.title ?? 'Откройте, чтобы посмотреть',
        section: 'focus',
      });
      // счётчик панели должен догнать событие, иначе бейдж отстанет на минуту
      window.dispatchEvent(new CustomEvent('teamcrm:tasks-changed'));
    };
    socket.on('task.for_you', onForYou);
    return () => { socket.off('task.for_you', onForYou); };
  }, [enabled]);

  // Ушли из приложения (вышли, закрыли) — заголовок обязан вернуться к обычному.
  useEffect(() => () => stopTabAlert(), []);
}
