import { useState } from 'react';
import { Icon } from '../../components/Icon';
import { plural } from '../../lib/chat-text';
import { navigate } from '../../lib/router';
import { startOfDay } from '../../lib/calendar-grid';

export interface DueTask {
  id: string; title: string; deadline_at: string; project_id: string; status: string;
  priority?: string | null; closed_at?: string | null;
}

const ROWS = 2;
const isDone = (t: DueTask) => !!t.closed_at || t.status === 'DONE';
const open = (t: DueTask) => navigate({ section: 'projects', projectId: String(t.project_id), taskId: String(t.id) });
/**
 * Срок без времени (#4892, п. 8): дату без часа хранят как 00:00, 23:59 по месту или
 * 21:00 по Москве (18:00 UTC). Такой срок — «весь день», а не «00:00 · просрочено» или «21:00».
 */
export function isTimeless(iso: string): boolean {
  const d = new Date(iso);
  const hm = d.getHours() * 60 + d.getMinutes();
  return hm === 0 || hm === 23 * 60 + 59 || (d.getUTCHours() === 18 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0);
}

const when = (t: DueTask, today: number) => {
  const d = new Date(t.deadline_at);
  const time = isTimeless(t.deadline_at) ? 'весь день' : d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return startOfDay(d).getTime() === today ? time : `${d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' })}, ${time}`;
};

/**
 * Сроки над расписанием (#4787, п. 2): не больше двух строк, остальное — «Ещё N задач».
 *
 * Раньше сроки стояли полосой в каждой колонке дня, и при тридцати задачах на день
 * встречи уезжали вниз. Теперь: выполненные скрыты, просроченные — своим раскрываемым
 * списком, название целиком — в карточке задачи (по нажатию).
 */
export function DeadlinesBar({ tasks, overdue, days }: { tasks: DueTask[]; overdue: DueTask[]; days: Date[] }) {
  const [more, setMore] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [overdueOpen, setOverdueOpen] = useState(false);
  const today = startOfDay(new Date()).getTime();
  const inToday = days.some((d) => startOfDay(d).getTime() === today);
  // в виде с сегодняшним днём главное — «закончить сегодня»; иначе — сроки показанных дней
  const scope = inToday ? tasks.filter((t) => startOfDay(new Date(t.deadline_at)).getTime() === today) : tasks;
  const overdueIds = new Set(overdue.map((t) => t.id));
  const done = scope.filter(isDone);
  const open_ = scope.filter((t) => !isDone(t) && !overdueIds.has(t.id));
  const list = showDone ? [...open_, ...done] : open_;
  const visible = more ? list : list.slice(0, ROWS);
  const hidden = list.length - visible.length;
  if (!scope.length && !overdue.length) return null;

  const label = inToday
    ? `Нужно закончить сегодня: ${open_.length} ${plural(open_.length, 'задача', 'задачи', 'задач')}`
    : days.length === 1
      ? `Сроки на ${days[0].toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}: ${open_.length}`
      : `Сроки в этом промежутке: ${open_.length}`;

  return (
    <section className="cal-due" aria-label="Задачи со сроком">
      <div className="cal-due-head">
        <Icon name="flag" size={14} />
        <strong>{label}</strong>
        {overdue.length > 0 && (
          <button className="cal-due-overdue" aria-expanded={overdueOpen} onClick={() => setOverdueOpen((v) => !v)}>
            <Icon name="alert" size={12} /> Просрочено: {overdue.length}
            <Icon name={overdueOpen ? 'chevron-up' : 'chevron-down'} size={12} />
          </button>
        )}
        {done.length > 0 && (
          <button className="cal-due-link" onClick={() => setShowDone((v) => !v)}>
            {showDone ? 'Скрыть выполненные' : `Выполненные: ${done.length}`}
          </button>
        )}
      </div>
      {overdueOpen && (
        <ul className="cal-due-list cal-due-list-overdue">
          {overdue.map((t) => (
            <li key={`o${t.id}`}>
              <button className="cal-due-item overdue" onClick={() => open(t)} title={`${t.title} — открыть карточку`}>
                <span className="cal-due-num">№{t.id}</span> — <span className="cal-due-title">{t.title}</span>
                <span className="cal-due-when">{when(t, today)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {visible.length > 0 && (
        <ul className="cal-due-list">
          {visible.map((t) => (
            <li key={t.id}>
              <button className={`cal-due-item${isDone(t) ? ' done' : ''}${t.priority === 'urgent' || t.priority === 'high' ? ' hot' : ''}`}
                onClick={() => open(t)} title={`${t.title} — открыть карточку`}>
                {isDone(t) && <Icon name="check" size={12} />}
                <span className="cal-due-num">№{t.id}</span> — <span className="cal-due-title">{t.title}</span>
                <span className="cal-due-when">{when(t, today)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {(hidden > 0 || more) && list.length > ROWS && (
        <button className="cal-due-link" onClick={() => setMore((v) => !v)}>
          {more ? 'Свернуть' : `Ещё ${hidden} ${plural(hidden, 'задача', 'задачи', 'задач')}`}
        </button>
      )}
    </section>
  );
}
