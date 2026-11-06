/**
 * Короткие решения и глубокая работа (#4767): длительность — из оценки задачи.
 * Короткое решение — 10 минут, средняя задача — 30, сложная — 50–60 минут и больше
 * (по оценке, до 120 — дольше фокус не бывает). Согласование — всегда короткое решение.
 * Оценки нет — так и говорим: «без оценки», время выбирает человек, точность не рисуем.
 */
export type FocusSize = 'short' | 'medium' | 'deep' | 'unknown';

export function focusSize(kind: string, estimateMin: number | null | undefined): { size: FocusSize; minutes: number | null; label: string } {
  if (kind === 'approval') return { size: 'short', minutes: 10, label: 'Короткое решение · 10 мин' };
  if (!estimateMin || estimateMin <= 0) return { size: 'unknown', minutes: null, label: 'Без оценки' };
  if (estimateMin <= 15) return { size: 'short', minutes: 10, label: 'Короткое решение · 10 мин' };
  if (estimateMin <= 45) return { size: 'medium', minutes: 30, label: 'Средняя задача · 30 мин' };
  const minutes = Math.min(120, Math.max(60, Math.round(estimateMin / 10) * 10));
  return { size: 'deep', minutes, label: `Глубокая работа · ${minutes} мин` };
}
