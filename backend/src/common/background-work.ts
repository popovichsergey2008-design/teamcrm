/**
 * Фоновая работа процесса, которую нельзя оборвать перезапуском (21.10).
 *
 * Разбор созвона идёт в памяти API: дорожки, распознавание, итоги. Выкладка гасила
 * прежний цвет через полминуты после конца созвона — и разбор 37-минутной встречи
 * пропадал молча, статус навсегда оставался «Расшифровываю…». Выкладка спрашивает
 * `/health/busy` и ждёт, пока счётчик не обнулится.
 */
let running = 0;

export function trackBackground<T>(work: Promise<T>): Promise<T> {
  running++;
  return work.finally(() => { running--; });
}

export function backgroundCount(): number {
  return running;
}
