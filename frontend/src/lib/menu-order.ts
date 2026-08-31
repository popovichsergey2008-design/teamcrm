/**
 * Личный порядок пунктов меню.
 *
 * Люди работают по-разному: кому-то каждый день нужны доски, кому-то переписка,
 * а «Пульс команды» смотрят раз в неделю. Порядок — вопрос привычки, и спорить
 * с ней бессмысленно; проще дать переставить.
 *
 * Настройка приходит с сервера (она у человека, а не в браузере), поэтому здесь
 * важнее всего устойчивость: список разделов меняется от версии к версии, а
 * сохранённый порядок остаётся старым. Новые пункты не должны пропадать, исчезнувшие —
 * ломать список.
 */

export interface MenuPrefs {
  /** Ключи разделов в том порядке, в каком их расставил человек. */
  order?: string[];
  /** Что он спрятал. */
  hidden?: string[];
}

/** Разделы, которые нельзя спрятать: без них из интерфейса не выбраться. */
export const PROTECTED = ['settings'];

/**
 * Расставить пункты по личному порядку.
 *
 * Незнакомые ключи из настройки игнорируются, а разделы, которых в ней нет,
 * встают в конец в исходном порядке: после обновления системы новый раздел просто
 * появится внизу, а не потеряется.
 */
export function applyOrder<T extends { section: string }>(items: T[], prefs?: MenuPrefs): T[] {
  const order = prefs?.order ?? [];
  if (!order.length) return items;

  const byKey = new Map(items.map((i) => [i.section, i]));
  const sorted: T[] = [];
  for (const key of order) {
    const item = byKey.get(key);
    if (item) { sorted.push(item); byKey.delete(key); }
  }
  // всё, чего не было в сохранённом порядке, — в конец, сохраняя исходную последовательность
  for (const item of items) if (byKey.has(item.section)) sorted.push(item);
  return sorted;
}

/** Убрать спрятанное. Защищённые разделы остаются, даже если попали в список скрытых. */
export function applyHidden<T extends { section: string }>(items: T[], prefs?: MenuPrefs): T[] {
  const hidden = new Set(prefs?.hidden ?? []);
  return items.filter((i) => !hidden.has(i.section) || PROTECTED.includes(i.section));
}

export function isHidden(section: string, prefs?: MenuPrefs): boolean {
  return (prefs?.hidden ?? []).includes(section) && !PROTECTED.includes(section);
}

/**
 * Переставить пункт на новое место.
 *
 * Возвращает полный порядок, а не «дельту»: сохранять надо целиком, иначе два
 * перетаскивания подряд с разных вкладок дадут порядок, которого никто не выбирал.
 */
export function moveItem(order: string[], section: string, toIndex: number): string[] {
  const from = order.indexOf(section);
  if (from < 0) return order;
  const next = [...order];
  next.splice(from, 1);
  next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, section);
  return next;
}

/** Спрятать или вернуть раздел. Защищённые не прячутся ни при каких обстоятельствах. */
export function toggleHidden(hidden: string[], section: string): string[] {
  if (PROTECTED.includes(section)) return hidden;
  return hidden.includes(section) ? hidden.filter((s) => s !== section) : [...hidden, section];
}
