/** «1 ч 20 мин» — сэкономленное время секретаря (сайдбар и панель секретаря). */
export function humanMinutes(total: number): string {
  if (total <= 0) return '0 мин';
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${m} мин`;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}
