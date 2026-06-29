/**
 * Детерминированный расчёт Velocity и ёмкости (Шаг 4.1). Без LLM. Чистые функции.
 * Velocity = успешно_закрытые_задачи / затраченное_время (задач/час).
 */

export function computeVelocity(closedTasks: number, trackedHours: number): number {
  if (trackedHours <= 0) return 0;
  return Math.round((closedTasks / trackedHours) * 10000) / 10000;
}

/**
 * Ёмкость сотрудника за период (часов) с учётом доступности:
 * дневная ёмкость = недельная/7; вычитаем дни отсутствий (отпуск/больничный).
 */
export function capacityHours(
  weeklyCapacityHours: number,
  windowDays: number,
  absenceDays: number,
): number {
  const daily = weeklyCapacityHours / 7;
  const effectiveDays = Math.max(0, windowDays - absenceDays);
  return Math.round(daily * effectiveDays * 100) / 100;
}
