/**
 * #4889: в проверки задачи — обязательный пункт про скриншоты «было» и «стало».
 *
 * Добавляется к чек-листу, который пришёл вместе с задачей (из чата, голосом, со
 * встречи): без снимков результат принять нельзя, а неотмеченный пункт не даёт сдать
 * задачу — колонка приёмки требует выполненный чек-лист.
 */
export const SHOTS_ITEM = 'Приложить скриншоты «было» и «стало» (вкладка «Было/стало»)';

// пункт уже есть, сказанный своими словами: «скрин до/после», «было и стало», «screenshot»
const HAS_SHOTS = /скрин|снимк|screenshot|было\s*[/и,-]+\s*стало/i;

export function withShotsItem(items: readonly string[]): string[] {
  const clean = items.map((t) => String(t ?? '').trim()).filter(Boolean);
  if (!clean.length || clean.some((t) => HAS_SHOTS.test(t))) return clean;
  return [...clean, SHOTS_ITEM];
}
