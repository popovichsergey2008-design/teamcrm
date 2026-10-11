import { useEffect } from 'react';
import { getSocket } from '../lib/socket';

/** Сервер сказал «у вас изменились данные» — экраны перечитывают своё (#1531). */
export const DATA_CHANGED = 'teamcrm:data-changed';

/**
 * Живое обновление всего приложения (#1531).
 *
 * Раньше события задач слышала только открытая доска проекта, а счётчики в меню,
 * «Фокус дня», реестр задач, таблица проектов и уведомления обновлялись раз в минуту
 * или при переходе в другой раздел: «исчезает, только когда зайдёшь во все задачи».
 *
 * Теперь сервер на любое изменение задач, согласований и ящика шлёт короткий сигнал
 * `data.changed` (склеенный за 300 мс), а здесь он превращается в те же оконные события,
 * которые экраны и так слушают после собственных действий человека:
 * `teamcrm:tasks-changed` — счётчики, фокус, секретарь; `teamcrm:projects-changed`
 * — только если менялись сами проекты; `teamcrm:data-changed` — реестр и таблица проектов. Своих правок в сигнале нет смысла отсеивать: перезапрос дешёвый.
 */
export function useLiveSignals(signedIn: boolean): void {
  useEffect(() => {
    if (!signedIn) return;
    const socket = getSocket();
    let timer: number | null = null;
    let projectsTouched = false;
    const fire = (p?: { events?: string[] }) => {
      // список проектов перечитывает и доска — дёргаем его, только когда менялись сами проекты
      if (p?.events?.some((e) => e.startsWith('project.'))) projectsTouched = true;
      // склейка на стороне клиента: сигнал по каждому устройству и вкладке — один перезапрос
      if (timer != null) return;
      timer = window.setTimeout(() => {
        timer = null;
        window.dispatchEvent(new Event('teamcrm:tasks-changed'));
        if (projectsTouched) window.dispatchEvent(new Event('teamcrm:projects-changed'));
        projectsTouched = false;
        window.dispatchEvent(new Event(DATA_CHANGED));
      }, 150);
    };
    socket.on('data.changed', fire);
    return () => {
      socket.off('data.changed', fire);
      if (timer != null) window.clearTimeout(timer);
    };
  }, [signedIn]);
}
