/**
 * «Мои задачи» внутри проекта.
 *
 * Отдельного запроса не делаем: доска уже загружена целиком, и фильтр по исполнителю
 * — это работа над теми же данными. Лишний поход в сеть ради того, что лежит в памяти,
 * человек почувствовал бы как задержку переключателя.
 */

interface TaskLike {
  assignee_id?: string | null;
}

interface ColumnLike<T> {
  id: string;
  name: string;
  tasks: T[];
}

/**
 * Оставить только свои задачи и убрать колонки, где после этого пусто.
 *
 * Пустые колонки не показываем сознательно: в списке из десяти заголовков без единой
 * строки невозможно понять, есть ли у тебя вообще работа по проекту.
 */
export function onlyMine<T extends TaskLike, C extends ColumnLike<T>>(columns: C[], userId: string): C[] {
  return columns
    .map((col) => ({ ...col, tasks: col.tasks.filter((t) => String(t.assignee_id ?? '') === String(userId)) }))
    .filter((col) => col.tasks.length > 0);
}

/** Сколько задач проекта назначено на человека — число рядом с переключателем. */
export function countMine<T extends TaskLike, C extends ColumnLike<T>>(columns: C[], userId: string): number {
  return columns.reduce(
    (sum, col) => sum + col.tasks.filter((t) => String(t.assignee_id ?? '') === String(userId)).length,
    0,
  );
}
