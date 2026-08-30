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

interface TaskLike {
  id?: string;
  assignee_id?: string | null;
  /** Постановщик задачи. В базе это `created_by` — тот, кто задачу завёл. */
  created_by?: string | null;
}

interface ColumnLike<T> {
  id: string;
  name: string;
  tasks: T[];
}

/**
 * Что показывать:
 * `off` — всю команду; `assigned` — назначенное мне; `created` — поставленное мной;
 * `both` — и то и другое (моя работа целиком, как её видит сам человек).
 */
export type MineMode = 'off' | 'assigned' | 'created' | 'both';

const eq = (a: unknown, b: unknown) => String(a ?? '') === String(b ?? '') && String(a ?? '') !== '';

export const isAssignedTo = (task: TaskLike, userId: string) => eq(task.assignee_id, userId);
export const isCreatedBy = (task: TaskLike, userId: string) => eq(task.created_by, userId);

/**
 * Подходит ли задача под текущий выбор.
 *
 * Постановщик из выпадающего списка работает НЕЗАВИСИМО от режима «мои»: выбрав
 * коллегу, человек видит всё, что тот раздал, — кому бы ни назначил.
 */
export function matches<T extends TaskLike>(
  task: T,
  o: { userId: string; mode: MineMode; creatorId?: string | null },
): boolean {
  if (o.creatorId && !isCreatedBy(task, o.creatorId)) return false;
  switch (o.mode) {
    case 'assigned': return isAssignedTo(task, o.userId);
    case 'created': return isCreatedBy(task, o.userId);
    case 'both': return isAssignedTo(task, o.userId) || isCreatedBy(task, o.userId);
    default: return true;
  }
}

/** Фильтр вообще что-то отсекает? От этого зависит и пересчёт позиций при переносе. */
export const filterActive = (o: { mode: MineMode; creatorId?: string | null }): boolean =>
  o.mode !== 'off' || !!o.creatorId;

/**
 * Оставить подходящие задачи.
 *
 * `keepEmpty` — про доску: колонки там показывают процесс, и исчезающая «Проверка»
 * ломает и понимание, и перетаскивание, ведь бросать задачу становится некуда.
 * В списке наоборот: десять пустых заголовков не отвечают ни на один вопрос.
 */
export function filterBoard<T extends TaskLike, C extends ColumnLike<T>>(
  columns: C[],
  o: { userId: string; mode: MineMode; creatorId?: string | null },
  keepEmpty = false,
): C[] {
  const filtered = columns.map((col) => ({ ...col, tasks: col.tasks.filter((t) => matches(t, o)) }));
  return keepEmpty ? filtered : filtered.filter((col) => col.tasks.length > 0);
}

/** Сколько задач подходит под выбор — число на переключателе. */
export function countMatching<T extends TaskLike, C extends ColumnLike<T>>(
  columns: C[],
  o: { userId: string; mode: MineMode; creatorId?: string | null },
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
  o: { userId: string; mode: MineMode; creatorId?: string | null },
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
