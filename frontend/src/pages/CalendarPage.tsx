import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Avatar } from '../components/Avatar';
import { DatePicker } from '../components/DatePicker';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { api, ApiError } from '../lib/api';
import {
  addDays, daysOf, DaySegment, isDayOff, layoutDay, rangeTitle, splitByDay, startOfDay, timeToFraction,
} from '../lib/calendar-grid';
import type { User } from '../types';

type View = 'day' | 'week' | 'month' | 'list';

export interface CalEvent {
  id: string;
  scope: 'personal' | 'company';
  title: string;
  description: string | null;
  location: string | null;
  meetRoomId: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  color: string | null;
  isPrivate: boolean;
  ownerId: string;
  canEdit: boolean;
  myStatus: 'invited' | 'accepted' | 'declined' | null;
  /** Напоминания в минутах до начала. */
  reminders?: number[];
  participants: { userId: string; fullName: string | null; status: string; isOrganizer: boolean; avatarUrl: string | null }[];
}

interface CalTask { id: string; title: string; deadline_at: string; project_id: string; status: string }
interface Work { workStart: string; workEnd: string; weekendDays: number[]; holidays: string[] }

const VIEW_LABEL: Record<View, string> = { day: 'День', week: 'Неделя', month: 'Месяц', list: 'Список' };
/** Напоминания, которые предлагаем. Больше вариантов — дольше выбирать, а нужны эти пять. */
const REMINDER_CHOICES: { minutes: number; label: string }[] = [
  { minutes: 0, label: 'в момент начала' },
  { minutes: 5, label: 'за 5 минут' },
  { minutes: 15, label: 'за 15 минут' },
  { minutes: 60, label: 'за час' },
  { minutes: 1440, label: 'за день' },
];
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const HOUR_HEIGHT = 44; // высота часа в сетке, совпадает с .cal-hour в стилях
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const pad = (n: number) => String(n).padStart(2, '0');
/** Локальное значение для DatePicker. Через toISOString нельзя — он уводит в UTC и сдвигает день. */
const isoLocal = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

/**
 * Ближайшие полчаса от текущего момента.
 *
 * Кнопка «Событие» раньше брала «следующий час», и в 23:30 это уезжало на завтрашнюю
 * полночь: человек жал «создать», а событие оказывалось в другом дне с временем 00:00.
 */
function nextHalfHour(): Date {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() > 30 ? 60 : 30);
  return d;
}

/**
 * Файл встречи → в календарь человека.
 *
 * Через blob, а не прямой ссылкой: файл лежит за авторизацией, и <a href> дал бы 401
 * без единого объяснения — браузер просто открыл бы пустую страницу.
 */
async function downloadIcs(id: string): Promise<void> {
  try {
    const blob = await api.calendarIcs(id);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'meeting.ics';
    a.click();
    URL.revokeObjectURL(url);
  } catch { /* кнопка — удобство; молчаливый отказ лучше пугающей ошибки поверх формы */ }
}

/** Имя организатора — то, что человек ищет глазами первым: кто зовёт. */
function organizerOf(e: CalEvent): string | null {
  return e.participants.find((p) => p.isOrganizer)?.fullName ?? null;
}

/** Подсказка при наведении: время, кто зовёт, кто приглашён и о чём встреча. */
function hint(e: CalEvent): string {
  const lines = [`${e.allDay ? 'Весь день' : `${hhmm(e.startsAt)}–${hhmm(e.endsAt)}`} · ${e.title}`];
  const org = organizerOf(e);
  if (org) lines.push(`Создал: ${org}`);
  const guests = e.participants.filter((p) => !p.isOrganizer);
  if (guests.length) {
    lines.push(`Приглашены: ${guests.map((p) => `${p.fullName}${p.status === 'declined' ? ' (отказался)' : p.status === 'invited' ? ' (не ответил)' : ''}`).join(', ')}`);
  }
  if (e.location) lines.push(`Место: ${e.location}`);
  if (e.description) lines.push(e.description.slice(0, 200));
  return lines.join(String.fromCharCode(10));
}

/**
 * Календарь: события людей и компании, задачи со сроком отдельным слоем.
 *
 * Неделя — основной вид: рабочая неделя это то, что человек планирует. День нужен, когда
 * встреч много, месяц — чтобы увидеть загрузку целиком, список — чтобы прочитать ближайшее
 * подряд, не разбирая сетку.
 */
export function CalendarPage({ onStartCall }: { onStartCall: (roomId: string) => void }) {
  const [view, setView] = useState<View>(() => (localStorage.getItem('teamcrm.calendarView') as View) || 'week');
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [tasks, setTasks] = useState<CalTask[]>([]);
  const [work, setWork] = useState<Work>({ workStart: '09:00', workEnd: '18:00', weekendDays: [0, 6], holidays: [] });
  const [showTasks, setShowTasks] = useState(() => localStorage.getItem('teamcrm.calendarTasks') !== '0');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState<Partial<CalEvent> | null>(null);
  const [people, setPeople] = useState<User[]>([]);

  const days = useMemo(() => daysOf(view, anchor), [view, anchor]);
  const from = days[0];
  const to = addDays(days[days.length - 1], 1);

  const reload = useCallback(async () => {
    setErr('');
    try {
      const r = await api.calendarRange(from.toISOString(), to.toISOString(), showTasks);
      setEvents(r.events);
      setTasks(r.tasks ?? []);
      setWork(r.work);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось загрузить календарь');
    } finally {
      setLoading(false);
    }
    // from/to считаются из days — зависимость по строкам, иначе перезапрос на каждый рендер
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from.getTime(), to.getTime(), showTasks]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { api.listUsers().then(setPeople).catch(() => undefined); }, []);

  const switchView = (v: View) => { setView(v); localStorage.setItem('teamcrm.calendarView', v); };
  const toggleTasks = () => {
    const next = !showTasks;
    setShowTasks(next);
    localStorage.setItem('teamcrm.calendarTasks', next ? '1' : '0');
  };

  const move = (dir: -1 | 1) => {
    if (view === 'month') setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1));
    else setAnchor(addDays(anchor, dir * (view === 'week' ? 7 : view === 'list' ? 14 : 1)));
  };

  /** Щелчок по свободному месту — это и есть создание: форма открывается уже с временем. */
  const createAt = (day: Date, hour: number) => {
    const start = new Date(day);
    start.setHours(hour, 0, 0, 0);
    openNew(start);
  };

  /** Кнопка «Событие»: ближайшие полчаса, а не полночь и не завтрашний день. */
  const createNow = () => openNew(nextHalfHour());

  const openNew = (start: Date) => {
    const end = new Date(start.getTime() + 3600_000);
    setEditing({ startsAt: start.toISOString(), endsAt: end.toISOString(), scope: 'personal', participants: [] });
  };

  const respond = async (id: string, status: 'accepted' | 'declined') => {
    try {
      await api.calendarRespond(id, status);
      await reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось ответить');
    }
  };

  const timed = events.filter((e) => !e.allDay);
  const allDay = events.filter((e) => e.allDay);

  const segmentsByDay = useMemo(() => {
    const per: DaySegment<CalEvent>[][] = days.map(() => []);
    for (const e of timed) for (const seg of splitByDay(e, days)) per[seg.dayIndex].push(seg);
    return per.map((list) => layoutDay(list));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, days]);

  const tasksOfDay = (day: Date) => tasks.filter((t) => startOfDay(new Date(t.deadline_at)).getTime() === startOfDay(day).getTime());
  const allDayOf = (day: Date) => allDay.filter((e) => splitByDay(e, [day]).length > 0);

  return (
    <div className="page calendar-page">
      <div className="cal-head">
        <div className="cal-nav">
          <button className="btn btn-sm" onClick={() => setAnchor(new Date())}>Сегодня</button>
          <button className="btn btn-ghost btn-sm" onClick={() => move(-1)} aria-label="Назад"><Icon name="chevron-left" size={16} /></button>
          <button className="btn btn-ghost btn-sm" onClick={() => move(1)} aria-label="Вперёд"><Icon name="chevron-right" size={16} /></button>
          <h2 className="cal-title">{rangeTitle(view, days)}</h2>
        </div>
        <div className="cal-actions">
          <label className="cal-tasks-toggle" title="Показывать задачи со сроком отдельным слоем">
            <input type="checkbox" checked={showTasks} onChange={toggleTasks} /> Задачи
          </label>
          <div className="cal-views">
            {(Object.keys(VIEW_LABEL) as View[]).map((v) => (
              <button key={v} className={`cal-view ${view === v ? 'active' : ''}`} onClick={() => switchView(v)}>
                {VIEW_LABEL[v]}
              </button>
            ))}
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => createNow()}>
            <Icon name="plus" size={15} /> Событие
          </button>
        </div>
      </div>

      {err && <div className="error-text">{err}</div>}

      {view === 'list' ? (
        <ListView days={days} events={events} tasks={showTasks ? tasks : []} onOpen={setEditing} onRespond={respond} />
      ) : view === 'month' ? (
        <MonthGrid days={days} events={events} tasks={showTasks ? tasks : []} work={work} anchor={anchor} onOpen={setEditing} onCreate={(d) => createAt(d, 10)} />
      ) : (
        <TimeGrid
          days={days}
          work={work}
          segments={segmentsByDay}
          allDayOf={allDayOf}
          tasksOfDay={showTasks ? tasksOfDay : () => []}
          onOpen={setEditing}
          onCreate={createAt}
        />
      )}

      {loading && <div className="dim" style={{ padding: 12 }}>Загружаю…</div>}

      {editing && (
        <EventDialog
          value={editing}
          people={people}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await reload(); }}
          onStartCall={onStartCall}
          onRespond={respond}
        />
      )}
    </div>
  );
}

/** Сетка дня и недели: часы слева, события в колонках дней. */
function TimeGrid({ days, work, segments, allDayOf, tasksOfDay, onOpen, onCreate }: {
  days: Date[];
  work: Work;
  segments: DaySegment<CalEvent>[][];
  allDayOf: (d: Date) => CalEvent[];
  tasksOfDay: (d: Date) => CalTask[];
  onOpen: (e: CalEvent) => void;
  onCreate: (day: Date, hour: number) => void;
}) {
  const today = startOfDay(new Date()).getTime();
  const workTop = timeToFraction(work.workStart);
  const workHeight = Math.max(timeToFraction(work.workEnd) - workTop, 0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hasTasks = days.some((d) => tasksOfDay(d).length > 0);

  /**
   * Прокрутка к началу рабочего дня.
   *
   * Сетка открывалась на полуночи, и человек видел пустую ночь, а щелчок «по первому
   * свободному месту» создавал событие в 00:00. Показываем час до начала работы —
   * чтобы было видно, что выше тоже есть время.
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = Math.max(0, (timeToFraction(work.workStart) * 24 - 1) * HOUR_HEIGHT);
  }, [work.workStart, days.length]);

  // колонок ровно столько, сколько дней в виде: одна в дне, семь в неделе
  const columns = { ['--cal-days' as string]: String(days.length) } as React.CSSProperties;

  return (
    <div className="cal-grid" style={columns}>
      <div className="cal-corner" />
      {days.map((d) => (
        <div key={`h${d.getTime()}`} className={`cal-dayhead ${startOfDay(d).getTime() === today ? 'today' : ''} ${isDayOff(d, work) ? 'off' : ''}`}>
          <span className="cal-dayname">{d.toLocaleDateString('ru-RU', { weekday: 'short' })}</span>
          <span className="cal-daynum">{d.getDate()}</span>
        </div>
      ))}

      {/* События «весь день» — своей строкой. У них нет времени внутри суток, в сетке им не место */}
      <div className="cal-corner cal-allday-label">весь день</div>
      {days.map((d) => (
        <div key={`a${d.getTime()}`} className="cal-allday">
          {allDayOf(d).map((e) => (
            <button key={e.id} className={`cal-chip ${e.scope === 'company' ? 'company' : ''}`} onClick={() => onOpen(e)} title={hint(e)}>
              {e.title}
            </button>
          ))}
        </div>
      ))}

      {/* Сроки задач — ОТДЕЛЬНОЙ строкой со своей подписью. В одной полосе с событиями
          «весь день» они читались как чужой мусор: непонятно, встреча это или задача. */}
      {hasTasks && (
        <>
          <div className="cal-corner cal-allday-label">сроки</div>
          {days.map((d) => (
            <div key={`t${d.getTime()}`} className="cal-allday cal-deadlines">
              {tasksOfDay(d).map((t) => (
                <span key={t.id} className="cal-chip cal-chip-task" title={`Срок задачи: ${t.title}`}>
                  <Icon name="flag" size={11} /> {t.title}
                </span>
              ))}
            </div>
          ))}
        </>
      )}

      <div className="cal-scroll" style={columns} ref={scrollRef}>
        <div className="cal-hours">
          {HOURS.map((h) => <div key={h} className="cal-hour"><span>{String(h).padStart(2, '0')}:00</span></div>)}
        </div>
        {days.map((d, i) => (
          <div key={`c${d.getTime()}`} className={`cal-col ${isDayOff(d, work) ? 'off' : ''}`}>
            {/* рабочие часы подсвечены, остальное приглушено — по настройке организации */}
            <div className="cal-worktime" style={{ top: `${workTop * 100}%`, height: `${workHeight * 100}%` }} />
            {HOURS.map((h) => (
              <button key={h} className="cal-slot" onClick={() => onCreate(d, h)} aria-label={`Создать событие ${d.toLocaleDateString('ru-RU')} в ${h}:00`} />
            ))}
            {segments[i]?.map((seg) => (
              <button
                key={`${seg.event.id}-${seg.dayIndex}`}
                className={`cal-event ${seg.event.scope === 'company' ? 'company' : ''} ${seg.event.myStatus === 'declined' ? 'declined' : ''} ${seg.event.myStatus === 'invited' ? 'invited' : ''}`}
                style={{
                  top: `${seg.top * 100}%`,
                  height: `${seg.height * 100}%`,
                  left: `${(seg.column / seg.columns) * 100}%`,
                  width: `${(1 / seg.columns) * 100}%`,
                }}
                onClick={() => onOpen(seg.event)}
                title={hint(seg.event)}
              >
                <span className="cal-event-time">
                  {seg.continuesFrom ? '↑ ' : ''}{hhmm(seg.event.startsAt)}
                  {seg.event.participants.length > 1 && (
                    <span className="cal-event-people"><Icon name="users" size={11} /> {seg.event.participants.length}</span>
                  )}
                </span>
                <span className="cal-event-title">{seg.event.title}</span>
                {/* организатор виден прямо на плитке: «кто зовёт» — первый вопрос к встрече */}
                {organizerOf(seg.event) && <span className="cal-event-who">{organizerOf(seg.event)}</span>}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Месяц: только факт занятости дня — время в такой клетке всё равно не прочитать. */
function MonthGrid({ days, events, tasks, work, anchor, onOpen, onCreate }: {
  days: Date[]; events: CalEvent[]; tasks: CalTask[]; work: Work; anchor: Date;
  onOpen: (e: CalEvent) => void; onCreate: (d: Date) => void;
}) {
  const today = startOfDay(new Date()).getTime();
  return (
    <div className="cal-month">
      {['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].map((d) => <div key={d} className="cal-month-head">{d}</div>)}
      {days.map((d) => {
        const dayEvents = events.filter((e) => splitByDay(e, [d]).length > 0);
        const dayTasks = tasks.filter((t) => startOfDay(new Date(t.deadline_at)).getTime() === startOfDay(d).getTime());
        return (
          <div
            key={d.getTime()}
            className={`cal-month-cell ${d.getMonth() !== anchor.getMonth() ? 'other' : ''} ${isDayOff(d, work) ? 'off' : ''} ${startOfDay(d).getTime() === today ? 'today' : ''}`}
            onDoubleClick={() => onCreate(d)}
          >
            <span className="cal-month-num">{d.getDate()}</span>
            {dayEvents.slice(0, 3).map((e) => (
              <button key={e.id} className={`cal-chip ${e.scope === 'company' ? 'company' : ''}`} onClick={() => onOpen(e)}>
                {e.allDay ? '' : `${hhmm(e.startsAt)} `}{e.title}
              </button>
            ))}
            {dayTasks.slice(0, 2).map((t) => (
              <span key={t.id} className="cal-chip cal-chip-task">{t.title}</span>
            ))}
            {dayEvents.length + dayTasks.length > 5 && (
              <span className="dim" style={{ fontSize: 11 }}>ещё {dayEvents.length + dayTasks.length - 5}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Список: ближайшее подряд. Нужен, когда важно прочитать, а не разглядывать сетку. */
function ListView({ days, events, tasks, onOpen, onRespond }: {
  days: Date[]; events: CalEvent[]; tasks: CalTask[];
  onOpen: (e: CalEvent) => void; onRespond: (id: string, s: 'accepted' | 'declined') => void;
}) {
  const rows = days.map((d) => ({
    day: d,
    events: events.filter((e) => splitByDay(e, [d]).length > 0),
    tasks: tasks.filter((t) => startOfDay(new Date(t.deadline_at)).getTime() === startOfDay(d).getTime()),
  })).filter((r) => r.events.length || r.tasks.length);

  if (!rows.length) {
    return <EmptyState icon="calendar" title="Впереди пусто" hint="На ближайшие две недели событий нет. Щёлкните по сетке в виде «Неделя», чтобы назначить встречу." />;
  }

  return (
    <div className="cal-list">
      {rows.map((r) => (
        <div key={r.day.getTime()} className="cal-list-day">
          <div className="cal-list-date">{r.day.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
          {r.events.map((e) => (
            <div key={e.id} className="cal-list-row">
              <span className="cal-list-time">{e.allDay ? 'весь день' : `${hhmm(e.startsAt)}–${hhmm(e.endsAt)}`}</span>
              <button className="cal-list-title" onClick={() => onOpen(e)}>
                <span>{e.title}</span>
                {/* кто зовёт и о чём — прямо в списке: ради этого не должно приходиться открывать событие */}
                <span className="cal-list-sub dim">
                  {organizerOf(e) ? `Создал: ${organizerOf(e)}` : ''}
                  {e.participants.length > 1 ? ` · участников: ${e.participants.length}` : ''}
                  {e.description ? ` · ${e.description.slice(0, 90)}` : ''}
                </span>
              </button>
              {e.myStatus === 'invited' && (
                <span className="cal-list-answer">
                  <button className="btn btn-sm" onClick={() => onRespond(e.id, 'accepted')}>Принять</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => onRespond(e.id, 'declined')}>Отклонить</button>
                </span>
              )}
            </div>
          ))}
          {r.tasks.map((t) => (
            <div key={t.id} className="cal-list-row">
              <span className="cal-list-time dim">срок</span>
              <span className="cal-list-title dim">{t.title}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Сдвиг конца вслед за началом.
 *
 * Человек меняет время начала — и ждёт, что встреча просто переедет, сохранив длительность.
 * Без этого он каждый раз правит два поля, а забыв второе, получает событие «с 15:00 до 11:00».
 */
function shiftEnd(nextStart: string, prevStart: string, prevEnd: string): string {
  const a = new Date(prevStart);
  const b = new Date(prevEnd);
  const next = new Date(nextStart);
  if ([a, b, next].some((d) => Number.isNaN(d.getTime()))) return prevEnd;
  const moved = new Date(next.getTime() + Math.max(b.getTime() - a.getTime(), 0));
  const pad2 = (n: number) => String(n).padStart(2, '0');
  return `${moved.getFullYear()}-${pad2(moved.getMonth() + 1)}-${pad2(moved.getDate())}T${pad2(moved.getHours())}:${pad2(moved.getMinutes())}`;
}

/** Создание и правка события. Одна форма на оба случая: разница только в кнопках снизу. */
function EventDialog({ value, people, onClose, onSaved, onStartCall, onRespond }: {
  value: Partial<CalEvent>;
  people: User[];
  onClose: () => void;
  onSaved: () => void;
  onStartCall: (roomId: string) => void;
  onRespond: (id: string, s: 'accepted' | 'declined') => void;
}) {
  const [form, setForm] = useState({
    title: value.title ?? '',
    description: value.description ?? '',
    location: value.location ?? '',
    startsAt: isoLocal(new Date(value.startsAt ?? Date.now())),
    endsAt: isoLocal(new Date(value.endsAt ?? Date.now() + 3600_000)),
    allDay: !!value.allDay,
    isPrivate: !!value.isPrivate,
    scope: (value.scope ?? 'personal') as 'personal' | 'company',
    participantIds: (value.participants ?? []).filter((p) => !p.isOrganizer).map((p) => String(p.userId)),
    // у новой встречи напоминание за 15 минут стоит сразу: это привычная норма,
    // а «ни одного напоминания» человек выбирает осознанно
    reminders: value.id ? (value.reminders ?? []) : [15],
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const isNew = !value.id;
  const canEdit = isNew || !!value.canEdit;

  const save = async () => {
    if (!form.title.trim()) return setErr('Назовите событие');
    setBusy(true);
    setErr('');
    try {
      const body = {
        title: form.title.trim(),
        description: form.description.trim() || undefined,
        location: form.location.trim() || undefined,
        startsAt: new Date(form.startsAt).toISOString(),
        endsAt: new Date(form.endsAt).toISOString(),
        allDay: form.allDay,
        isPrivate: form.isPrivate,
        scope: form.scope,
        participantIds: form.participantIds,
        reminders: form.reminders,
      };
      if (isNew) await api.calendarCreate(body);
      else await api.calendarUpdate(String(value.id), body);
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!value.id || !window.confirm(`Удалить событие «${value.title}»?`)) return;
    try {
      await api.calendarDelete(String(value.id));
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось удалить');
    }
  };

  const toggleParticipant = (id: string) => setForm((f) => ({
    ...f,
    participantIds: f.participantIds.includes(id)
      ? f.participantIds.filter((x) => x !== id)
      : [...f.participantIds, id],
  }));

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3><Icon name="calendar" size={18} /> {isNew ? 'Новое событие' : value.title}</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose} title="Закрыть"><Icon name="close" /></button>
        </div>

        {!isNew && organizerOf(value as CalEvent) && (
          <div className="cal-organizer">
            <Icon name="user" size={14} /> Создал: <b>{organizerOf(value as CalEvent)}</b>
          </div>
        )}
        {!canEdit && (
          <div className="dim" style={{ fontSize: 12 }}>
            Событие создал другой человек — вы можете только ответить на приглашение.
          </div>
        )}

        <div className="field">
          <label>Название</label>
          <input className="input" value={form.title} disabled={!canEdit}
                 onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </div>

        <div className="drawer-grid2">
          <div className="field">
            <label>Начало</label>
            {/* Наш календарь вместо datetime-local: тот в тёмной теме выглядит чужеродно
                и в каждом браузере по-своему. У «весь день» время не спрашиваем вовсе. */}
            <DatePicker
              value={form.startsAt}
              withTime={!form.allDay}
              disabled={!canEdit}
              placeholder="когда начинаем"
              onChange={(v) => setForm((f) => ({ ...f, startsAt: v, endsAt: shiftEnd(v, f.startsAt, f.endsAt) }))}
            />
          </div>
          <div className="field">
            <label>Конец</label>
            <DatePicker
              value={form.endsAt}
              withTime={!form.allDay}
              disabled={!canEdit}
              placeholder="когда заканчиваем"
              onChange={(v) => setForm({ ...form, endsAt: v })}
            />
          </div>
        </div>

        <label className="notify-row">
          <input type="checkbox" checked={form.allDay} disabled={!canEdit}
                 onChange={(e) => setForm({ ...form, allDay: e.target.checked })} /> Весь день
        </label>
        <label className="notify-row" title="Другие увидят только занятое время, без названия">
          <input type="checkbox" checked={form.isPrivate} disabled={!canEdit}
                 onChange={(e) => setForm({ ...form, isPrivate: e.target.checked })} /> Приватное
        </label>
        <label className="notify-row" title="Событие компании видят все сотрудники">
          <input type="checkbox" checked={form.scope === 'company'} disabled={!canEdit}
                 onChange={(e) => setForm({ ...form, scope: e.target.checked ? 'company' : 'personal' })} /> Событие компании
        </label>

        <div className="field">
          <label>Место или ссылка</label>
          <input className="input" value={form.location} disabled={!canEdit} placeholder="Переговорная, адрес или ссылка"
                 onChange={(e) => setForm({ ...form, location: e.target.value })} />
        </div>

        <div className="field">
          <label>Описание и повестка</label>
          <textarea className="input" rows={3} value={form.description} disabled={!canEdit}
                    onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </div>

        <div className="drawer-section-title">Напоминания</div>
        <div className="cal-reminders">
          {REMINDER_CHOICES.map((r) => (
            <label key={r.minutes} className={`cal-reminder ${form.reminders.includes(r.minutes) ? 'on' : ''}`}>
              <input
                type="checkbox"
                checked={form.reminders.includes(r.minutes)}
                disabled={!canEdit}
                onChange={() => setForm((prev) => ({
                  ...prev,
                  reminders: prev.reminders.includes(r.minutes)
                    ? prev.reminders.filter((m) => m !== r.minutes)
                    : [...prev.reminders, r.minutes].sort((a, b) => a - b),
                }))}
              />
              {r.label}
            </label>
          ))}
        </div>
        <div className="dim" style={{ fontSize: 12 }}>
          Придёт письмом и всплывёт в приложении. Участникам — тоже.
        </div>

        {canEdit && (
          <>
            <div className="drawer-section-title">Участники</div>
            <div className="cal-people">
              {people.filter((u) => u.role !== 'client' && u.isActive !== false).map((u) => (
                <label key={u.id} className="call-starter-row">
                  <input type="checkbox" checked={form.participantIds.includes(String(u.id))}
                         onChange={() => toggleParticipant(String(u.id))} />
                  <Avatar path={u.avatarUrl ?? null} fallback={u.fullName?.[0]?.toUpperCase() ?? '?'} className="avatar-sm" />
                  <span className="call-starter-name">{u.fullName}</span>
                </label>
              ))}
            </div>
          </>
        )}

        {!isNew && value.participants && value.participants.length > 0 && (
          <>
            <div className="drawer-section-title">Кто идёт</div>
            {value.participants.map((p) => (
              <div key={p.userId} className="cal-participant">
                <Avatar path={p.avatarUrl} fallback={p.fullName?.[0]?.toUpperCase() ?? '?'} className="avatar-sm" />
                <span className="call-starter-name">{p.fullName}</span>
                <span className={`cal-status cal-status-${p.status}`}>
                  {p.isOrganizer ? 'организатор' : p.status === 'accepted' ? 'идёт' : p.status === 'declined' ? 'отказался' : 'не ответил'}
                </span>
              </div>
            ))}
          </>
        )}

        {err && <div className="error-text">{err}</div>}

        <div className="cal-dialog-actions">
          {value.myStatus === 'invited' && value.id && (
            <>
              <button className="btn btn-primary btn-sm" onClick={() => { onRespond(String(value.id), 'accepted'); onClose(); }}>Принять</button>
              <button className="btn btn-sm" onClick={() => { onRespond(String(value.id), 'declined'); onClose(); }}>Отклонить</button>
            </>
          )}
          {/* Созвон нашей комнаты: у события своя комната, туда же ведёт гостевая ссылка */}
          {value.meetRoomId && (
            <button className="btn btn-sm" onClick={() => { onStartCall(String(value.meetRoomId)); onClose(); }}>
              <Icon name="phone" size={14} /> Войти в созвон
            </button>
          )}
          {/* Файл встречи: кладётся в Google, Outlook или календарь телефона одним щелчком */}
          {!isNew && (
            <button className="btn btn-sm" onClick={() => downloadIcs(String(value.id))} title="Добавить встречу в свой календарь — Google, Outlook, телефон">
              <Icon name="download" size={14} /> В свой календарь
            </button>
          )}
          {canEdit && <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Сохраняю…' : 'Сохранить'}</button>}
          {canEdit && !isNew && <button className="btn btn-ghost btn-sm" onClick={remove}>Удалить</button>}
        </div>
      </aside>
    </div>
  );
}
