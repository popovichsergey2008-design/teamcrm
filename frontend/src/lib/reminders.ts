/**
 * Напоминания о встрече: подписи и добавление своего времени.
 *
 * Вынесено из формы, потому что тут легко ошибиться незаметно: «за 90 минут» должно
 * читаться как «за 1 ч 30 мин», ноль — это «в момент начала», а не «за 0 минут»,
 * и дубли не должны появляться, когда человек вводит руками то, что уже отмечено
 * галочкой.
 */

/** Больше шести напоминаний на одну встречу — это уже не напоминание, а преследование. */
export const MAX_REMINDERS = 6;

export type ReminderUnit = 'minutes' | 'hours' | 'days';

/** Перевод в минуты — в них напоминания и хранятся. */
export function toMinutes(value: number, unit: ReminderUnit): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 0) return NaN;
  const factor = unit === 'days' ? 1440 : unit === 'hours' ? 60 : 1;
  return n * factor;
}

/** Человеческая подпись: «за 1 ч 30 мин», а не «за 90 минут». */
export function reminderLabel(minutes: number): string {
  if (minutes === 0) return 'в момент начала';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days} дн.`);
  if (hours) parts.push(`${hours} ч`);
  if (mins) parts.push(`${mins} мин`);
  return `за ${parts.join(' ')}`;
}

/**
 * Добавить своё время. Возвращает прежний список, если добавлять нечего:
 * значение уже есть, оно за пределами разумного или напоминаний и так шесть.
 */
export function addReminder(list: number[], minutes: number): number[] {
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 20160) return list; // дальше двух недель не напоминаем
  if (list.includes(minutes)) return list;
  if (list.length >= MAX_REMINDERS) return list;
  return [...list, minutes].sort((a, b) => a - b);
}

/** Что показать в форме: стандартные варианты плюс то, что человек добавил сам. */
export function reminderRows(list: number[], choices: number[]): { minutes: number; label: string; custom: boolean }[] {
  const own = list.filter((m) => !choices.includes(m));
  return [...choices, ...own]
    .sort((a, b) => a - b)
    .map((minutes) => ({ minutes, label: reminderLabel(minutes), custom: !choices.includes(minutes) }));
}
