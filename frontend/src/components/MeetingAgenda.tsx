import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon';
import { api } from '../lib/api';
import type { Agenda } from '../types';

/**
 * Повестка ближайшей встречи.
 *
 * Появляется примерно за пять минут до начала и живёт, пока встреча идёт. Смысл
 * ровно один: чтобы разговор не начинался с «так, а о чём мы хотели поговорить?» —
 * этот вопрос стоит первых пяти минут каждой планёрки.
 *
 * Кнопка «Войти» рядом с повесткой не случайно: человек читает пункты и тут же
 * заходит, не возвращаясь в календарь искать ссылку.
 */

const AGENDA_EVENT = 'teamcrm:assistant-agenda';

export function notifyAgendaArrived(): void {
  window.dispatchEvent(new CustomEvent(AGENDA_EVENT));
}

/** «через 4 мин» / «идёт» — человеку важно только это, а не точное время начала. */
function when(startsAt: string): string {
  const diff = Math.round((new Date(startsAt).getTime() - Date.now()) / 60_000);
  if (diff <= 0) return 'идёт сейчас';
  if (diff === 1) return 'через минуту';
  return `через ${diff} мин`;
}

export function MeetingAgenda({ onJoin }: { onJoin: (roomId: string) => void }) {
  const [items, setItems] = useState<Agenda[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);

  const load = useCallback(() => {
    api.assistantAgendas().then(setItems).catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    window.addEventListener(AGENDA_EVENT, load);
    // время до начала идёт: «через 5 мин» через минуту должно стать «через 4 мин»
    const timer = setInterval(load, 60_000);
    return () => {
      window.removeEventListener(AGENDA_EVENT, load);
      clearInterval(timer);
    };
  }, [load]);

  const visible = items.filter((a) => !hidden.includes(a.eventId));
  if (!visible.length) return null;

  return (
    <>
      {visible.map((a) => (
        <section key={a.eventId} className="card agenda-box">
          <h3 className="ping-head">
            <Icon name="calendar" size={15} /> {a.title} — {when(a.startsAt)}
            <span className="ping-actions">
              {a.meetRoomId && (
                <button className="btn btn-sm btn-primary" onClick={() => onJoin(a.meetRoomId as string)}>
                  <Icon name="video" size={13} /> Войти
                </button>
              )}
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setHidden((prev) => [...prev, a.eventId])}
                title="Скрыть до конца дня"
              >
                Скрыть
              </button>
            </span>
          </h3>
          {/* повестку показываем как написано: модель уже разложила её по строкам */}
          <div className="agenda-body">{a.body}</div>
        </section>
      ))}
    </>
  );
}
