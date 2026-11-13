/**
 * Привычка (#4891, п. 12): мягкая серия «дней с планом» и разбор недели. Чистые функции.
 *
 * Серия как в Todoist: выходные и отпуск не считаются вовсе, один пропущенный рабочий день
 * серию не обнуляет (просто не прибавляет), обнуляют только два пропуска подряд.
 */
export interface StreakDay { date: string; planned: boolean; off: boolean }

/** days — по убыванию даты, начиная с сегодняшнего. Сегодня без плана — ещё не пропуск. */
export function softStreak(days: StreakDay[]): number {
  let streak = 0;
  let missed = 0;
  days.forEach((d, i) => {
    if (missed >= 2 || d.off) return;
    if (d.planned) { streak++; missed = 0; return; }
    if (i === 0) return;
    missed++;
  });
  return streak;
}

/** Час с наибольшим значением: «лучшее время для фокуса», «когда больше всего прерываний». */
export function peakHour(byHour: Record<number, number>): number | null {
  let best: number | null = null;
  for (const [h, v] of Object.entries(byHour)) {
    if (v > 0 && (best === null || v > (byHour[best] ?? 0))) best = Number(h);
  }
  return best;
}

export const hourRange = (h: number) => `${String(h).padStart(2, '0')}:00–${String((h + 2) % 24).padStart(2, '0')}:00`;

/** «+1 ч 20 мин к прошлой неделе» / «−30 мин» / «как на прошлой неделе». */
export function compareMinutes(now: number, prev: number, fmt: (m: number) => string): string {
  const d = now - prev;
  if (Math.abs(d) < 10) return 'как на прошлой неделе';
  return `${d > 0 ? '+' : '−'}${fmt(Math.abs(d))} к прошлой неделе`;
}
