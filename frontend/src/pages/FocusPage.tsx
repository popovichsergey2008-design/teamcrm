import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { SkeletonList } from '../components/Skeleton';
import { api, ApiError } from '../lib/api';
import { deadlineBadge, priorityBadge } from '../lib/labels';
import { useAuth } from '../state/auth';
import type { Task } from '../types';

/** Задача из сквозной выборки — с именем проекта и колонки (доска не одна). */
type CrossTask = Task & { project_name: string; column_name: string };

/**
 * «Фокус дня» — экран, с которого начинается рабочий день.
 *
 * Три колонки из ТЗ, собранные на уже существующих данных:
 *   1. Требует моего решения — сдали и ждут приёмки;
 *   2. Что делать сегодня — сроки на сегодня, просрочка и срочное;
 *   3. Поручено мной — что я отдал другим и как оно движется.
 *
 * Порядок колонок не случаен: сначала разблокируй коллег, потом делай своё.
 * Ровно этому правилу учат команду при внедрении.
 *
 * Чего здесь пока нет и что честнее не изображать: сортировки «по важности» силами
 * ИИ, оценки «5 часов 30 минут» и утреннего брифинга. Для первого нужны оценки
 * времени, которых в задачах почти нет, для второго — согласования как сущность.
 */

const isOverdue = (t: CrossTask) => !!t.deadline_at && !t.closed_at && new Date(t.deadline_at) < new Date();

function endOfToday(): number {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Доброй ночи';
  if (h < 12) return 'Доброе утро';
  if (h < 18) return 'Добрый день';
  return 'Добрый вечер';
}

const DATE_FMT = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });

function FocusCard({ task, side, onOpen }: {
  task: CrossTask;
  /** что показать справа: кто поручил или кому поручено */
  side: 'manager' | 'assignee' | null;
  onOpen: () => void;
}) {
  const prio = priorityBadge(task.priority);
  const due = deadlineBadge(task.deadline_at, !!task.closed_at);
  const who = side === 'manager' ? task.manager_name : side === 'assignee' ? task.assignee_name : null;
  const checklist = task.checklistTotal
    ? `${task.checklistDone ?? 0} из ${task.checklistTotal}`
    : null;

  return (
    <button className={`focus-card${isOverdue(task) ? ' focus-card-late' : ''}`} onClick={onOpen}>
      <span className="focus-card-title">{task.title}</span>
      <span className="focus-card-meta">
        <span className="badge badge-muted" title="Проект">{task.project_name}</span>
        {prio && <span className={prio.cls}>{prio.text}</span>}
        {due && <span className={due.cls} title={due.title}>{due.text}</span>}
        {checklist && <span className="focus-check"><Icon name="check" size={12} /> {checklist}</span>}
      </span>
      {who && (
        <span className="focus-card-who">
          <span className="avatar-xs avatar-ph">{who[0]?.toUpperCase()}</span>
          {who}
          {task.risk_level && task.risk_level !== 'green' && (
            <span className={`risk-dot risk-${task.risk_level}`} title="Риск срока" />
          )}
        </span>
      )}
    </button>
  );
}

export function FocusPage({ onOpenTask }: { onOpenTask: (projectId: string, taskId: string) => void }) {
  const { user } = useAuth();
  const [mine, setMine] = useState<CrossTask[]>([]);
  const [delegated, setDelegated] = useState<CrossTask[]>([]);
  const [review, setReview] = useState<CrossTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [showRest, setShowRest] = useState(false);

  const load = useCallback(async () => {
    setErr('');
    try {
      // closed=1 в своей выборке: закрытые сегодня нужны для полосы прогресса дня
      const [m, d, r] = await Promise.all([
        api.myTasks('mine', true),
        api.myTasks('delegated'),
        api.myTasks('review'),
      ]);
      setMine(m); setDelegated(d); setReview(r);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось загрузить задачи');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // задачу могли закрыть из карточки или доски — экран не должен врать до перезагрузки
    window.addEventListener('teamcrm:tasks-changed', load);
    return () => window.removeEventListener('teamcrm:tasks-changed', load);
  }, [load]);

  const till = endOfToday();
  const open = mine.filter((t) => !t.closed_at);
  const today = open.filter((t) => (t.deadline_at && new Date(t.deadline_at).getTime() <= till) || t.priority === 'urgent');
  const rest = open.filter((t) => !today.includes(t));
  const doneToday = mine.filter((t) => t.closed_at && new Date(t.closed_at).toDateString() === new Date().toDateString());
  const planned = today.length + doneToday.length;
  const donePct = planned ? Math.round((doneToday.length / planned) * 100) : 0;

  const openTask = (t: CrossTask) => onOpenTask(t.project_id, t.id);

  return (
    <div className="focus-page">
      <div className="focus-head">
        <div>
          <div className="focus-hello">{greeting()}, {user?.fullName?.split(' ')[0] ?? ''}!</div>
          <div className="dim">{DATE_FMT.format(new Date())}</div>
        </div>
        <div className="focus-progress-box">
          <div className="focus-progress-line">
            <span>{doneToday.length} из {planned} на сегодня</span>
            <span className="dim">{donePct}%</span>
          </div>
          <div className="focus-progress"><span style={{ width: `${donePct}%` }} /></div>
        </div>
      </div>

      {err && <div className="error-text">{err}</div>}

      <div className="focus-columns">
        <section className="focus-col">
          <h3 className="focus-col-head">
            <Icon name="alert" size={15} /> Требует моего решения
            {review.length > 0 && <span className="focus-col-count">{review.length}</span>}
          </h3>
          {loading && <SkeletonList rows={3} />}
          {!loading && review.length === 0 && (
            <EmptyState
              icon="check-circle"
              compact
              title="Ничего не ждёт вас"
              hint="Сюда попадают задачи, которые сдали на проверку, а поручали их вы."
            />
          )}
          {review.map((t) => <FocusCard key={t.id} task={t} side="assignee" onOpen={() => openTask(t)} />)}
        </section>

        <section className="focus-col">
          <h3 className="focus-col-head">
            <Icon name="target" size={15} /> Что делать сегодня
            {today.length > 0 && <span className="focus-col-count">{today.length}</span>}
          </h3>
          {loading && <SkeletonList rows={4} />}
          {!loading && today.length === 0 && (
            <EmptyState
              icon="target"
              compact
              title="На сегодня сроков нет"
              hint="Здесь собираются задачи со сроком на сегодня, просроченные и срочные."
            />
          )}
          {today.map((t) => <FocusCard key={t.id} task={t} side="manager" onOpen={() => openTask(t)} />)}

          {rest.length > 0 && (
            <>
              <button className="focus-more" onClick={() => setShowRest((v) => !v)}>
                {showRest ? 'Скрыть' : `Ещё ${rest.length} моих задач без срока на сегодня`}
              </button>
              {showRest && rest.map((t) => <FocusCard key={t.id} task={t} side="manager" onOpen={() => openTask(t)} />)}
            </>
          )}
        </section>

        <section className="focus-col">
          <h3 className="focus-col-head">
            <Icon name="send" size={15} /> Поручено мной
            {delegated.length > 0 && <span className="focus-col-count">{delegated.length}</span>}
          </h3>
          {loading && <SkeletonList rows={3} />}
          {!loading && delegated.length === 0 && (
            <EmptyState
              icon="send"
              compact
              title="Вы никому не поручали задач"
              hint="Назначьте исполнителя в карточке — задача появится здесь вместе со сроком и риском."
            />
          )}
          {delegated.map((t) => <FocusCard key={t.id} task={t} side="assignee" onOpen={() => openTask(t)} />)}
        </section>
      </div>
    </div>
  );
}
