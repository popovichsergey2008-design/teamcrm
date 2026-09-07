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
}

interface ColumnLike<T> {
  id: string;
  name: string;
  tasks: T[];
}

/**
 * Что показывать. Четыре вида — общие для доски и раздела «Задачи» (см. `task-views`):
 * `doing` — я исполнитель; `delegated` — я поручил; `helping` — я соисполнитель;
 * `watching` — я наблюдатель. Плюс два особых значения: `off` — всю команду и
 * `both` — вся моя работа целиком (делаю, помогаю и поручил вместе).
 */
export type MineMode = 'off' | TaskView | 'both';

const eq = (a: unknown, b: unknown) => String(a ?? '') === String(b ?? '') && String(a ?? '') !== '';

/** Полный набор условий отбора: один объект на все функции модуля. */
export interface FilterOpts {
  userId: string;
  mode: MineMode;
  creatorId?: string | null;
  /** Скрыть завершённое — переключатель «Только в работе». */
  inWorkOnly?: boolean;
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
export function matches<T extends TaskLike>(task: T, o: FilterOpts): boolean {
  // «Только в работе» отсекает завершённое ДО всех прочих условий: это ответ на
  // вопрос «что сейчас делается», и он не зависит от того, чья это задача.
  if (o.inWorkOnly && task.closed_at) return false;
  if (o.creatorId && !isCreatedBy(task, o.creatorId)) return false;
  switch (o.mode) {
    case 'doing': return eq(task.assignee_id, o.userId);
    case 'helping': return isHelping(task, o.userId);
    case 'delegated': return isCreatedBy(task, o.userId);
    case 'watching': return isWatching(task, o.userId);
    case 'both': return isAssignedTo(task, o.userId) || isCreatedBy(task, o.userId);
    default: return true;
  }
}

/** Фильтр вообще что-то отсекает? От этого зависит и пересчёт позиций при переносе. */
export const filterActive = (o: FilterOpts): boolean =>
  o.mode !== 'off' || !!o.creatorId || !!o.inWorkOnly;

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
  const filtered = columns.map((col) => ({ ...col, tasks: col.tasks.filter((t) => matches(t, o)) }));
  return keepEmpty ? filtered : filtered.filter((col) => col.tasks.length > 0);
}

/** Сколько задач подходит под выбор — число на переключателе. */
export function countMatching<T extends TaskLike, C extends ColumnLike<T>>(
  columns: C[],
  o: FilterOpts,
): number {
  return columns.reduce((sum, col) => sum + col.tasks.filter((t) => matches(t, o)).length, 0);
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
): number {
  const shownAt: number[] = [];
  fullTasks.forEach((t, i) => { if (matches(t, o)) shownAt.push(i); });
  // видимых в колонке нет — человек бросает «просто сюда»; ставим в конец,
  // чтобы не влезать поверх задач, которых он сейчас не видит
  if (!shownAt.length) return fullTasks.length;
  if (visibleIndex <= 0) return shownAt[0];
  if (visibleIndex >= shownAt.length) return fullTasks.length; // бросили ниже последней видимой — в конец
  return shownAt[visibleIndex];
}
