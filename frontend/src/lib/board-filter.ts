/**
 * Фильтры доски: чьи задачи показывать.
 *
 * Это именно фильтр, а не отдельный вид: человек остаётся там, где был — на доске
 * или в списке, — и просто перестаёт видеть чужое. Отдельного запроса не делаем,
 * доска уже загружена целиком, а лишний поход в сеть ощущался бы как задержка
 * переключателя.
 *
 * «Мои задачи» разделены на две разные вещи, потому что это разные роли в работе:
 * назначенное на меня я делаю сам, поставленное мной — жду от других. Смешивать их
 * в одном списке значит смешивать «что мне делать» и «что с меня спросят».
 */

import type { TaskView } from './task-views';

/**
 * Быстрые условия доски (#4799 §3.2–3.3). Соединяются И: «Ждут моего решения» + «Срок
 * сегодня» — карточка должна подходить под оба.
 */
export type QuickKey = 'decide' | 'today' | 'blocked' | 'overdue' | 'answer';

/** Этапы, на которых работа сдана и ждёт решения (ТЗ-30). */
export const REVIEW_STAGES = ['testing', 'review', 'approval'];
/** Этапы, на которых срок исполнителя не тикает: работа у проверяющего или клиента. */
export const PAUSED_STAGES = ['testing', 'review', 'approval', 'waiting_external'];

interface TaskLike {
  id?: string;
  assignee_id?: string | null;
  /** Постановщик задачи. В базе это `created_by` — тот, кто задачу завёл. */
  created_by?: string | null;
  /** Кто делает работу вместе с исполнителем. */
  co_assignees?: { userId: string }[];
  /** Кто следит за задачей, не выполняя её. */
  watchers?: { userId: string }[];
  /** Задача закрыта: по этому полю работает переключатель «Только в работе». */
  closed_at?: string | null;
  title?: string;
  description?: string | null;
  deadline_at?: string | null;
  approval_state?: string;
  reviewer_id?: string | null;
  is_blocked?: boolean;
  blocker?: { helper_id?: string | null } | null;
  priority?: string;
  labels?: { id: string }[];
}

interface ColumnLike<T> {
  id: string;
  name: string;
  tasks: T[];
  /** Тип этапа колонки (ТЗ-30): по нему «Ждут моего решения» и «Просроченные». */
  stage_type?: string;
}

/**
 * Что показывать. Четыре вида — общие для доски и раздела «Задачи» (см. `task-views`):
 * `doing` — я исполнитель; `delegated` — я поручил; `helping` — я соисполнитель;
 * `watching` — я наблюдатель. Плюс два особых значения: `off` — всю команду и
 * `both` — всё, где я участвую: делаю, помогаю, поручил и наблюдаю (#1545).
 */
export type MineMode = 'off' | TaskView | 'both';

const eq = (a: unknown, b: unknown) => String(a ?? '') === String(b ?? '') && String(a ?? '') !== '';

/** Полный набор условий отбора: один объект на все функции модуля. */
export interface FilterOpts {
  userId: string;
  mode: MineMode;
  /**
   * #4799: роли «Моих задач» галочками — соединяются ИЛИ. Пустой набор в режиме «Мои»
   * не значит «всё»: это все четыре роли (их и восстанавливаем при возврате).
   */
  roles?: TaskView[];
  creatorId?: string | null;
  /** Скрыть завершённое — переключатель «Только в работе». */
  inWorkOnly?: boolean;
  quick?: QuickKey[];
  assigneeId?: string | null;
  /** Колонка: на доске прочие колонки остаются, но пустыми. */
  columnId?: string | null;
  priority?: string | null;
  labelId?: string | null;
  /** Поиск по ЭТОЙ доске: номер, название, описание. */
  search?: string;
  now?: Date;
}

/** Срок — на сегодняшнюю дату по часам человека. Просроченная задача сюда не входит. */
const sameLocalDay = (iso: string, now: Date) => {
  const d = new Date(iso);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
};

/** Чьего решения ждёт сданная работа: назначенного проверяющего, иначе постановщика. */
export const reviewerOf = (task: TaskLike) => task.reviewer_id ?? task.created_by ?? null;

/** Задача ждёт решения именно этого человека (#4799 §3.3): сдана, не принята, решать ему. */
export function waitsForDecision(task: TaskLike, userId: string, stage?: string): boolean {
  if (task.closed_at) return false;
  const inReview = task.approval_state === 'pending' || (!!stage && REVIEW_STAGES.includes(stage));
  return inReview && eq(reviewerOf(task), userId);
}

function quickMatch(task: TaskLike, k: QuickKey, o: FilterOpts, stage?: string): boolean {
  const now = o.now ?? new Date();
  switch (k) {
    case 'decide': return waitsForDecision(task, o.userId, stage);
    case 'today': return !task.closed_at && !!task.deadline_at && sameLocalDay(task.deadline_at, now);
    case 'overdue': {
      if (task.closed_at || !task.deadline_at || new Date(task.deadline_at).getTime() >= now.getTime()) return false;
      // работа у проверяющего или клиента — это не просрочка исполнителя (ТЗ-30)
      return task.approval_state !== 'pending' && !(stage && PAUSED_STAGES.includes(stage));
    }
    // только явная отметка: просрочка сама по себе препятствием не считается
    case 'blocked': return !!task.is_blocked;
    case 'answer': return !!task.is_blocked && eq(task.blocker?.helper_id, o.userId);
    default: return true;
  }
}

function searchMatch(task: TaskLike, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  const num = s.replace(/^#/, '');
  if (/^\d+$/.test(num) && String(task.id ?? '') === num) return true;
  return (task.title ?? '').toLowerCase().includes(s) || (task.description ?? '').toLowerCase().includes(s);
}

function roleMatch(task: TaskLike, role: TaskView, userId: string): boolean {
  switch (role) {
    case 'doing': return eq(task.assignee_id, userId);
    case 'helping': return isHelping(task, userId);
    case 'delegated': return isCreatedBy(task, userId);
    case 'watching': return isWatching(task, userId);
    default: return false;
  }
}

/**
 * Задача «на мне» — если я исполнитель ИЛИ соисполнитель.
 *
 * Соисполнитель делает ту же работу, и не показывать её ему в «Мне» значит заставлять
 * искать собственные задачи по чужим доскам.
 */
export const isAssignedTo = (task: TaskLike, userId: string) => (
  eq(task.assignee_id, userId)
  || (task.co_assignees ?? []).some((p) => eq(p.userId, userId))
);
export const isCreatedBy = (task: TaskLike, userId: string) => eq(task.created_by, userId);
/** Только соисполнитель: «Помогаю» — это вторая пара рук, а не своя задача. */
export const isHelping = (task: TaskLike, userId: string) =>
  (task.co_assignees ?? []).some((p) => eq(p.userId, userId));
export const isWatching = (task: TaskLike, userId: string) =>
  (task.watchers ?? []).some((p) => eq(p.userId, userId));

/**
 * Подходит ли задача под текущий выбор.
 *
 * Постановщик из выпадающего списка работает НЕЗАВИСИМО от режима «мои»: выбрав
 * коллегу, человек видит всё, что тот раздал, — кому бы ни назначил.
 */
export function matches<T extends TaskLike>(task: T, o: FilterOpts, stage?: string): boolean {
  // «Только в работе» отсекает завершённое ДО всех прочих условий: это ответ на
  // вопрос «что сейчас делается», и он не зависит от того, чья это задача. Признак —
  // факт закрытия, а не колонка: в «Готово» лежит и то, что ещё ждёт согласования.
  if (o.inWorkOnly && task.closed_at) return false;
  if (o.creatorId && !isCreatedBy(task, o.creatorId)) return false;
  // Прочие фильтры независимы друг от друга и соединяются И (#4799 §3.2).
  if (o.assigneeId && !isAssignedTo(task, o.assigneeId)) return false;
  if (o.priority && String(task.priority ?? 'normal') !== o.priority) return false;
  if (o.labelId && !(task.labels ?? []).some((l) => eq(l.id, o.labelId))) return false;
  if (o.search && !searchMatch(task, o.search)) return false;
  for (const k of o.quick ?? []) if (!quickMatch(task, k, o, stage)) return false;
  // Роли — ИЛИ: «Делаю» + «Помогаю» оставляет карточку, если подходит хоть одна.
  if (o.mode === 'both' && o.roles?.length) return o.roles.some((r) => roleMatch(task, r, o.userId));
  switch (o.mode) {
    case 'doing': return eq(task.assignee_id, o.userId);
    case 'helping': return isHelping(task, o.userId);
    case 'delegated': return isCreatedBy(task, o.userId);
    case 'watching': return isWatching(task, o.userId);
    case 'both': return isAssignedTo(task, o.userId) || isCreatedBy(task, o.userId) || isWatching(task, o.userId);
    default: return true;
  }
}

/** Фильтр вообще что-то отсекает? От этого зависит и пересчёт позиций при переносе. */
export const filterActive = (o: FilterOpts): boolean =>
  o.mode !== 'off' || !!o.creatorId || !!o.inWorkOnly || !!o.quick?.length || !!o.assigneeId
  || !!o.columnId || !!o.priority || !!o.labelId || !!o.search?.trim();

/**
 * Оставить подходящие задачи.
 *
 * `keepEmpty` — про доску: колонки там показывают процесс, и исчезающая «Проверка»
 * ломает и понимание, и перетаскивание, ведь бросать задачу становится некуда.
 * В списке наоборот: десять пустых заголовков не отвечают ни на один вопрос.
 */
export function filterBoard<T extends TaskLike, C extends ColumnLike<T>>(
  columns: C[],
  o: FilterOpts,
  keepEmpty = false,
): C[] {
  const filtered = columns.map((col) => ({
    ...col,
    tasks: o.columnId && !eq(col.id, o.columnId) ? [] : col.tasks.filter((t) => matches(t, o, col.stage_type)),
  }));
  return keepEmpty ? filtered : filtered.filter((col) => col.tasks.length > 0);
}

/** Сколько задач подходит под выбор — число на переключателе. */
export function countMatching<T extends TaskLike, C extends ColumnLike<T>>(
  columns: C[],
  o: FilterOpts,
): number {
  return columns.reduce((sum, col) => (o.columnId && !eq(col.id, o.columnId)
    ? sum
    : sum + col.tasks.filter((t) => matches(t, o, col.stage_type)).length), 0);
}

/**
 * Куда на самом деле встаёт задача, если на доске показаны не все.
 *
 * Перетаскивание сообщает индекс среди ВИДИМЫХ карточек. При включённом фильтре это
 * не настоящая позиция: бросив карточку между двумя видимыми, человек получил бы её
 * в начале колонки, потому что скрытые задачи между ними не посчитаны.
 * Переводим видимый индекс в место N-й видимой задачи внутри полной колонки.
 */
export function realPosition<T extends TaskLike>(
  fullTasks: T[],
  o: FilterOpts,
  visibleIndex: number,
  stage?: string,
): number {
  const shownAt: number[] = [];
  fullTasks.forEach((t, i) => { if (matches(t, o, stage)) shownAt.push(i); });
  // видимых в колонке нет — человек бросает «просто сюда»; ставим в конец,
  // чтобы не влезать поверх задач, которых он сейчас не видит
  if (!shownAt.length) return fullTasks.length;
  if (visibleIndex <= 0) return shownAt[0];
  if (visibleIndex >= shownAt.length) return fullTasks.length; // бросили ниже последней видимой — в конец
  return shownAt[visibleIndex];
}
