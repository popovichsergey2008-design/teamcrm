/**
 * Фильтр «только мои задачи».
 *
 * Это именно фильтр, а не отдельный вид: человек остаётся там, где был — на доске
 * или в списке, — и просто перестаёт видеть чужое. Отдельного запроса не делаем,
 * доска уже загружена целиком, а лишний поход в сеть ощущался бы как задержка
 * переключателя.
 */

interface TaskLike {
  id?: string;
  assignee_id?: string | null;
}

interface ColumnLike<T> {
  id: string;
  name: string;
  tasks: T[];
}

const isMine = (task: TaskLike, userId: string) => String(task.assignee_id ?? '') === String(userId);

/**
 * Оставить только свои задачи.
 *
 * `keepEmpty` — про доску: колонки там показывают процесс, и исчезающая «Проверка»
 * ломает и понимание, и перетаскивание, ведь бросать задачу становится некуда.
 * В списке наоборот: десять пустых заголовков не отвечают ни на один вопрос.
 */
export function onlyMine<T extends TaskLike, C extends ColumnLike<T>>(
  columns: C[],
  userId: string,
  keepEmpty = false,
): C[] {
  const filtered = columns.map((col) => ({ ...col, tasks: col.tasks.filter((t) => isMine(t, userId)) }));
  return keepEmpty ? filtered : filtered.filter((col) => col.tasks.length > 0);
}

/** Сколько задач проекта назначено на человека — число на переключателе. */
export function countMine<T extends TaskLike, C extends ColumnLike<T>>(columns: C[], userId: string): number {
  return columns.reduce((sum, col) => sum + col.tasks.filter((t) => isMine(t, userId)).length, 0);
}

/**
 * Куда на самом деле встаёт задача, если на доске показаны не все.
 *
 * Перетаскивание сообщает индекс среди ВИДИМЫХ карточек. При включённом фильтре это
 * не настоящая позиция: бросив карточку между двумя своими, человек получил бы её
 * в начале колонки, потому что чужие задачи между ними не посчитаны.
 * Переводим видимый индекс в место N-й своей задачи внутри полной колонки.
 */
export function realPosition<T extends TaskLike>(fullTasks: T[], userId: string, visibleIndex: number): number {
  const mineAt: number[] = [];
  fullTasks.forEach((t, i) => { if (isMine(t, userId)) mineAt.push(i); });
  // своих в колонке не видно — человек бросает «просто сюда»; ставим в конец,
  // чтобы не влезать поверх чужих задач, которых он сейчас не видит
  if (!mineAt.length) return fullTasks.length;
  if (visibleIndex <= 0) return mineAt[0];
  if (visibleIndex >= mineAt.length) return fullTasks.length; // бросили ниже последней своей — в конец
  return mineAt[visibleIndex];
}
