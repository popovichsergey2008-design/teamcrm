/**
 * Автоматическая постановка задачи (#4615): срок чипами и строки сводки «Так поставлю».
 *
 * Человек выбирает только срок: «Сегодня», «Завтра», «Послезавтра», «Через неделю»
 * или «Свой срок». Срок прозвучал во фразе — подходящий чип выбран сам (не подошёл ни
 * один — «Свой срок» с этой датой). Чистые функции: проверяются в logic-check.
 */

export type DeadlineChip = 'today' | 'tomorrow' | 'after' | 'week' | 'custom';

export const DEADLINE_CHIPS: { key: Exclude<DeadlineChip, 'custom'>; label: string; days: number }[] = [
  { key: 'today', label: 'Сегодня', days: 0 },
  { key: 'tomorrow', label: 'Завтра', days: 1 },
  { key: 'after', label: 'Послезавтра', days: 2 },
  { key: 'week', label: 'Через неделю', days: 7 },
];

/** Местная дата YYYY-MM-DD: «завтра» — завтра у человека, а не по UTC. */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function chipDate(key: Exclude<DeadlineChip, 'custom'>, now: Date): string {
  const days = DEADLINE_CHIPS.find((c) => c.key === key)?.days ?? 0;
  return localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
}

/** Какой чип горит для даты: совпала с готовым — он, иначе «Свой срок»; нет даты — ничего. */
export function chipFor(date: string | null | undefined, now: Date): DeadlineChip | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}/.test(date)) return null;
  const day = date.slice(0, 10);
  return DEADLINE_CHIPS.find((c) => chipDate(c.key, now) === day)?.key ?? 'custom';
}

/** Срок задачи: выбранный чипом главнее; не трогали — тот, что прозвучал во фразе. */
export function effectiveDeadline(heard: string | null | undefined, chosen: string | null, touched: boolean): string | null {
  if (touched) return chosen;
  return heard || chosen || null;
}

export const PRIORITY_LABEL: Record<string, string> = { low: 'Низкий', normal: 'Обычный', high: 'Высокий', urgent: 'Срочный' };

/** «23 окт.» — коротко, для сводки. */
export function shortDay(date: string | null | undefined): string {
  if (!date) return 'не выбран';
  const d = new Date(date.length === 10 ? `${date}T12:00:00` : date);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}
