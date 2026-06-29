/**
 * Чистый расчёт себестоимости задачи (Шаг 2.2). Тестируется юнит-тестами.
 *
 * Контракт:
 *  - стоимость = Σ по time_logs ( затреканные_секунды/3600 × ставка_на_момент_интервала );
 *  - интервал, пересекающий смену версии ставки, РАЗБИВАЕТСЯ по границам версий;
 *  - открытый time_log (end=null) считается до `now`;
 *  - полный пересчёт из всех логов → идемпотентность.
 */

export interface TimeLogInput {
  userId: string;
  start: Date;
  end: Date | null;
}

export interface RateVersion {
  userId: string;
  hourlyRate: number;
  effectiveFrom: Date;
  effectiveTo: Date | null; // null = действует сейчас
}

const HOUR_MS = 3_600_000;

/** Себестоимость одного интервала пользователя с сегментацией по версиям ставки. */
function intervalCost(
  start: Date,
  end: Date,
  rates: RateVersion[],
): number {
  if (end.getTime() <= start.getTime()) return 0;
  let cost = 0;
  for (const r of rates) {
    const rFrom = r.effectiveFrom.getTime();
    const rTo = r.effectiveTo ? r.effectiveTo.getTime() : Number.POSITIVE_INFINITY;
    const segStart = Math.max(start.getTime(), rFrom);
    const segEnd = Math.min(end.getTime(), rTo);
    if (segEnd > segStart) {
      cost += ((segEnd - segStart) / HOUR_MS) * r.hourlyRate;
    }
  }
  return cost;
}

/**
 * Полная себестоимость задачи по всем её time_logs и версионным ставкам.
 * @returns денежное значение, округлённое до 2 знаков.
 */
export function computeTaskCost(
  timeLogs: TimeLogInput[],
  rates: RateVersion[],
  now: Date,
): number {
  // ставки по пользователю, отсортированные по началу действия
  const byUser = new Map<string, RateVersion[]>();
  for (const r of rates) {
    const arr = byUser.get(r.userId) ?? [];
    arr.push(r);
    byUser.set(r.userId, arr);
  }
  for (const arr of byUser.values()) {
    arr.sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime());
  }

  let total = 0;
  for (const log of timeLogs) {
    const end = log.end ?? now;
    const userRates = byUser.get(log.userId);
    if (!userRates || userRates.length === 0) continue; // ставка не задана → 0
    total += intervalCost(log.start, end, userRates);
  }
  return Math.round(total * 100) / 100;
}

/**
 * Маржа проекта в %. budget=null → margin=null.
 * margin = (budget − cost) / budget × 100.
 */
export function computeMargin(budget: number | null, cost: number): number | null {
  if (budget === null || budget === 0) return null;
  return Math.round(((budget - cost) / budget) * 100 * 100) / 100;
}
