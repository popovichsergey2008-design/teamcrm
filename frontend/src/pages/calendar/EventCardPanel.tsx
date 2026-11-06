import { useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { api, ApiError, type EventCard } from '../../lib/api';
import { navigate } from '../../lib/router';
import './calendar.css';

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : '');

/**
 * Карточка встречи до и после созвона (#4787, п. 10–11).
 *
 * До: какой результат хотим получить, какие задачи связаны. После: что обсудили, какие
 * решения приняли, кто что должен и к какому сроку, ссылки на созданные задачи.
 * Участники, «что обсуждаем» (описание), документы и вход в созвон — в самом окне события.
 */
export function EventCardPanel({ eventId, canEdit, past }: { eventId: string; canEdit: boolean; past: boolean }) {
  const [card, setCard] = useState<EventCard | null>(null);
  const [goal, setGoal] = useState('');
  const [taskNo, setTaskNo] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    api.calendarEventCard(eventId).then((c) => { setCard(c); setGoal(c.goal ?? ''); }).catch(() => setCard(null));
  }, [eventId]);
  if (!card) return null;

  const run = async (fn: () => Promise<EventCard>) => {
    setErr('');
    try { const c = await fn(); setCard(c); setGoal(c.goal ?? ''); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
  };
  const open = (projectId: string | null, taskId: string | null) => { if (projectId && taskId) navigate({ section: 'projects', projectId, taskId }); };

  return (
    <div className="cal-card">
      <div className="cal-card-sec">
        <div className="cal-card-h"><Icon name="target" size={14} /> Какой результат хотим получить</div>
        {canEdit ? (
          <div className="cal-card-row">
            <Input value={goal} maxLength={500} placeholder="Например: согласовать главную страницу" onChange={(e) => setGoal(e.target.value)}
              onBlur={() => { if ((card.goal ?? '') !== goal.trim()) void run(() => api.calendarEventGoal(eventId, goal.trim() || null)); }} />
          </div>
        ) : <div>{card.goal || <span className="dim">Цель не указана</span>}</div>}
      </div>

      <div className="cal-card-sec">
        <div className="cal-card-h"><Icon name="check-circle" size={14} /> Задачи, связанные со встречей</div>
        {card.tasks.length ? (
          <ul className="cal-card-list">
            {card.tasks.map((t) => (
              <li key={t.id}>
                <button className="cal-due-item" onClick={() => open(t.projectId, t.id)}>
                  <span className="cal-due-num">№{t.id}</span> — <span className="cal-due-title">{t.title}</span>
                  <span className="cal-due-when">{t.assignee ?? ''}{t.deadlineAt ? ` · до ${day(t.deadlineAt)}` : ''}{t.done ? ' · сделано' : ''}{t.source === 'meeting' ? ' · из итогов' : ''}</span>
                </button>
                {t.source === 'linked' && (
                  <button className="cal-pill-x" aria-label="Отвязать задачу" onClick={() => void run(() => api.calendarEventUnlinkTask(eventId, t.id))}>×</button>
                )}
              </li>
            ))}
          </ul>
        ) : <div className="dim">Пока нет</div>}
        <div className="cal-card-row">
          <Input value={taskNo} onChange={(e) => setTaskNo(e.target.value.replace(/[^\d]/g, ''))} placeholder="Номер задачи" aria-label="Номер задачи" inputMode="numeric" />
          <Button size="sm" variant="ghost" disabled={!taskNo} onClick={() => { const n = taskNo; setTaskNo(''); void run(() => api.calendarEventLinkTask(eventId, n)); }}>
            <Icon name="plus" size={14} /> Связать
          </Button>
        </div>
      </div>

      {(card.after || past) && (
        <div className="cal-card-sec cal-card-after">
          <div className="cal-card-h"><Icon name="record" size={14} /> Результат встречи</div>
          {!card.after && <div className="dim">Итогов нет: созвон не записывался или ещё разбирается.</div>}
          {card.after && (
            <>
              {card.after.summary && <p className="cal-card-text">{card.after.summary}</p>}
              {card.after.decisions.length > 0 && (
                <>
                  <div className="cal-card-sub">Решения</div>
                  <ul className="cal-card-bul">{card.after.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul>
                </>
              )}
              {card.after.assignments.length > 0 && (
                <>
                  <div className="cal-card-sub">Кто что должен сделать</div>
                  <ul className="cal-card-bul">
                    {card.after.assignments.map((a, i) => (
                      <li key={i}>
                        {a.taskId ? <button className="cal-due-link" onClick={() => open(a.projectId, a.taskId)}>{a.title}</button> : a.title}
                        {a.assignee ? ` — ${a.assignee}` : ''}{a.deadlineAt ? `, до ${day(a.deadlineAt)}` : ''}
                        {!a.taskId && a.status !== 'applied' ? <span className="dim"> (ещё не задача)</span> : ''}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <button className="cal-due-link" onClick={() => navigate({ section: 'chat', view: 'postcall', meetingId: card.after!.meetingId })}>Полные итоги встречи</button>
            </>
          )}
        </div>
      )}
      {err && <div className="tv2-callout tv2-callout-danger" role="alert"><Icon name="alert" size={15} /> {err}</div>}
    </div>
  );
}
