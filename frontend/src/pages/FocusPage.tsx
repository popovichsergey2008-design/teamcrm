import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { SkeletonList } from '../components/Skeleton';
import { api, ApiError } from '../lib/api';
import { cached, dropCache } from '../lib/cache';
import { deadlineBadge, priorityBadge } from '../lib/labels';
import { useAuth } from '../state/auth';
import type { Approval, Task } from '../types';
import { ApprovalCard } from '../components/ApprovalCard';
import { LeftoversDialog, leftoversSeenToday } from '../components/LeftoversDialog';

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

/** Дата в формате ГГГГ-ММ-ДД по местным часам: сервер живёт в UTC, а день — у человека. */
function localDay(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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

function FocusCard({ task, side, onOpen, onPlan }: {
  task: CrossTask;
  /** что показать справа: кто поручил или кому поручено */
  side: 'manager' | 'assignee' | null;
  onOpen: () => void;
  /** планирование дня: доступно только по своим задачам */
  onPlan?: (date: string | null) => void;
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
      {onPlan && (
        // Планирование — отдельной строкой и явными словами: «сегодня» это личный план,
        // а не срок. Кнопка не должна читаться как перенос обязательства перед другими.
        <span className="focus-plan" onClick={(e) => e.stopPropagation()}>
          {task.focus_date === localDay()
            ? <button className="focus-plan-btn active" onClick={() => onPlan(null)}>Убрать из дня</button>
            : <button className="focus-plan-btn" onClick={() => onPlan(localDay())}>В сегодня</button>}
          <button className="focus-plan-btn" onClick={() => onPlan(localDay(1))}>На завтра</button>
        </span>
      )}
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

/** Прогрев по наведению на пункт меню: к клику данные уже здесь. */
export function prefetchFocus() {
  cached('focus:mine', () => api.myTasks('mine', true));
  cached('focus:delegated', () => api.myTasks('delegated'));
  cached('focus:review', () => api.myTasks('review'));
  cached('focus:approvals', () => api.approvalsInbox());
}

export function FocusPage({ onOpenTask, active = true }: {
  onOpenTask: (projectId: string, taskId: string) => void;
  /** экран остаётся смонтированным в фоне — в это время он не ходит в сеть */
  active?: boolean;
}) {
  const { user } = useAuth();
  const [mine, setMine] = useState<CrossTask[]>([]);
  const [delegated, setDelegated] = useState<CrossTask[]>([]);
  const [review, setReview] = useState<CrossTask[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  // вчерашние хвосты: спрашиваем один раз в день и только если они есть
  const [tails, setTails] = useState<(CrossTask)[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [showRest, setShowRest] = useState(false);

  const load = useCallback(async (fresh = false) => {
    setErr('');
    if (fresh) dropCache('focus:');
    try {
      // closed=1 в своей выборке: закрытые сегодня нужны для полосы прогресса дня
      const [m, d, r, a] = await Promise.all([
        cached('focus:mine', () => api.myTasks('mine', true)),
        cached('focus:delegated', () => api.myTasks('delegated')),
        cached('focus:review', () => api.myTasks('review')),
        cached('focus:approvals', () => api.approvalsInbox()),
      ]);
      setMine(m); setDelegated(d); setReview(r); setApprovals(a);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось загрузить задачи');
    } finally {
      setLoading(false);
    }
  }, []);

  // Разбор хвостов — при первом за день открытии экрана. Не при каждом заходе:
  // вопрос, который задают по десять раз, перестают читать.
  useEffect(() => {
    if (!active || leftoversSeenToday(localDay())) return;
    api.leftovers(localDay())
      .then((rows) => { if (rows.length) setTails(rows as CrossTask[]); })
      .catch(() => undefined);
  }, [active]);

  useEffect(() => {
    if (!active) return;
    load();
    // Задачу могли закрыть из карточки или доски — экран не должен врать.
    // В фоне не обновляемся: незачем ходить в сеть ради невидимого экрана,
    // всё равно перечитаем при возврате.
    const refresh = () => load(true);
    window.addEventListener('teamcrm:tasks-changed', refresh);
    return () => window.removeEventListener('teamcrm:tasks-changed', refresh);
  }, [load, active]);

  const till = endOfToday();
  const day = localDay();
  const open = mine.filter((t) => !t.closed_at);
  // День — это срок на сегодня, личный план на сегодня и срочное. Задача без срока
  // раньше не попадала в день вовсе, и её приходилось помнить в голове.
  const today = open.filter((t) =>
    (t.deadline_at && new Date(t.deadline_at).getTime() <= till)
    || t.focus_date === day
    || t.priority === 'urgent');
  const rest = open.filter((t) => !today.includes(t));
  const doneToday = mine.filter((t) => t.closed_at && new Date(t.closed_at).toDateString() === new Date().toDateString());
  const planned = today.length + doneToday.length;
  const donePct = planned ? Math.round((doneToday.length / planned) * 100) : 0;

  const openTask = (t: CrossTask) => onOpenTask(t.project_id, t.id);

  /**
   * Планирование дня. Список правим сразу, не дожидаясь сети: человек нажал «в сегодня»
   * и должен увидеть перемещение, а не задержку. Ошибка вернёт всё назад перезагрузкой.
   */
  const plan = async (task: CrossTask, date: string | null) => {
    setMine((prev) => prev.map((t) => (t.id === task.id ? { ...t, focus_date: date } : t)));
    try {
      await api.setFocusDate(task.id, date);
    } catch {
      load(true);
    }
  };

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
          <div
            className="focus-progress"
            role="progressbar"
            aria-valuenow={donePct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Закрыто ${doneToday.length} из ${planned} задач на сегодня`}
          >
            <span style={{ width: `${donePct}%` }} />
          </div>
        </div>
      </div>

      {err && <div className="error-text">{err}</div>}

      {tails && tails.length > 0 && (
        <LeftoversDialog
          tasks={tails}
          today={localDay()}
          onClose={() => setTails(null)}
          onDone={() => { setTails(null); load(true); }}
        />
      )}

      <div className="focus-columns">
        <section className="focus-col">
          <h3 className="focus-col-head">
            <Icon name="alert" size={15} /> Требует моего решения
            {review.length + approvals.length > 0 && (
              <span className="focus-col-count">{review.length + approvals.length}</span>
            )}
          </h3>
          {loading && <SkeletonList rows={3} />}
          {!loading && review.length + approvals.length === 0 && (
            <EmptyState
              icon="check-circle"
              compact
              title="Ничего не ждёт вас"
              hint="Сюда попадают сданные на проверку задачи и вопросы, на которые нужен ваш ответ."
            />
          )}

          {/* Согласования выше сданных работ: это чистое «да/нет» на минуту,
              а проверка результата требует времени и внимания. */}
          {approvals.map((a) => (
            <ApprovalCard
              key={a.id}
              approval={a}
              onOpenTask={onOpenTask}
              onDecided={(id) => {
                setApprovals((prev) => prev.filter((x) => x.id !== id));
                dropCache('focus:');
                // счётчик раздела считает согласования — он обязан обновиться сразу
                window.dispatchEvent(new Event('teamcrm:tasks-changed'));
              }}
            />
          ))}
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
          {today.map((t) => (
            <FocusCard key={t.id} task={t} side="manager" onOpen={() => openTask(t)} onPlan={(d) => plan(t, d)} />
          ))}

          {rest.length > 0 && (
            <>
              <button className="focus-more" onClick={() => setShowRest((v) => !v)}>
                {showRest ? 'Скрыть' : `Ещё ${rest.length} моих задач без срока на сегодня`}
              </button>
              {showRest && rest.map((t) => (
                <FocusCard key={t.id} task={t} side="manager" onOpen={() => openTask(t)} onPlan={(d) => plan(t, d)} />
              ))}
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
