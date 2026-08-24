/**
 * Крошечный кэш ответов на время жизни вкладки.
 *
 * Нужен ради требования ТЗ «переключение без спиннеров». Разделы, которые уже
 * открывали, остаются смонтированными и данные не теряют, но ПЕРВЫЙ заход всё
 * равно ждал бы сеть — поэтому по наведению на пункт меню запрос уходит заранее,
 * а экран потом забирает готовый результат отсюда.
 *
 * Осознанные границы: это не react-query и не хранилище состояния.
 * — короткий срок годности (по умолчанию 15 секунд): показать вчерашние цифры
 *   хуже, чем показать заглушку;
 * — сбрасывается на любое изменение задач и при смене организации, иначе человек
 *   увидит данные чужой компании;
 * — хранит промис, а не результат: два одновременных запроса схлопываются в один.
 */

type Entry = { at: number; promise: Promise<unknown> };

const store = new Map<string, Entry>();
const DEFAULT_TTL = 15_000;

export function cached<T>(key: string, fn: () => Promise<T>, ttlMs = DEFAULT_TTL): Promise<T> {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.promise as Promise<T>;

  const promise = fn().catch((e) => {
    store.delete(key); // неудачу не кэшируем: следующая попытка должна пойти в сеть
    throw e;
  });
  store.set(key, { at: Date.now(), promise });
  return promise;
}

/** Сбросить всё или ветку по префиксу ключа. */
export function dropCache(prefix?: string) {
  if (!prefix) return store.clear();
  for (const key of [...store.keys()]) if (key.startsWith(prefix)) store.delete(key);
}

/** Заранее прогреть кэш: результат никому не нужен, важно только, что он лёг в store. */
export function warm<T>(key: string, fn: () => Promise<T>, ttlMs?: number) {
  cached(key, fn, ttlMs).catch(() => undefined);
}
