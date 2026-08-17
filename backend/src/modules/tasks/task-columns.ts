/**
 * Колонка-«готово»: куда попадает задача, когда её завершают.
 *
 * Знание вынесено из TasksService, потому что закрыть задачу можно не только
 * переносом на доске: её закрывает импорт из YouGile (там «завершено» — флажок,
 * не зависящий от колонки) и разбор дейлика. Во всех случаях правило одно,
 * и держать его в трёх местах нельзя.
 */
const DONE_NAMES = new Set([
  'done', 'готово', 'выполнено', 'завершено', 'завершён', 'завершен', 'закрыто', 'сделано',
]);

export function isDoneColumn(name: string): boolean {
  return DONE_NAMES.has(name.trim().toLowerCase());
}

/** Список названий для SQL-запросов: в миграциях и репозиториях тот же набор. */
export const DONE_COLUMN_NAMES = [...DONE_NAMES];

/**
 * Колонка «готово» проекта — первая по порядку, если их вдруг несколько.
 * null означает, что переносить некуда: у проекта нет такой колонки,
 * и выдумывать её мы не станем — доска чужая.
 */
export function pickDoneColumn<T extends { id: string; name: string }>(columns: T[]): T | null {
  return columns.find((c) => isDoneColumn(c.name)) ?? null;
}
