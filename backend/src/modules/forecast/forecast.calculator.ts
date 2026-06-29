/**
 * Детерминированный прогноз срока и светофор риска (Шаг 4.2) + guard перегруза (Шаг 4.3).
 * Без LLM. Чистые функции — покрыты unit-тестами.
 */
export type RiskLevel = 'green' | 'yellow' | 'red';
const DAY_MS = 86_400_000;

export interface ForecastInput {
  estimateHours: number;
  queueAheadHours: number; // суммарная оценка задач впереди в очереди исполнителя
  weeklyCapacityHours: number;
  absenceDaysAhead: number; // отсутствия в горизонте сдвигают дату вправо
  deadline: Date | null;
  now: Date;
}

export interface ForecastResult {
  predictedFinish: Date;
  riskPct: number | null; // null если нет дедлайна
  level: RiskLevel;
}

export function computeForecast(i: ForecastInput): ForecastResult {
  const daily = i.weeklyCapacityHours > 0 ? i.weeklyCapacityHours / 7 : 1;
  const remainingHours = Math.max(0, i.queueAheadHours) + Math.max(0, i.estimateHours);
  const workDays = remainingHours / daily;
  const calendarDays = workDays + Math.max(0, i.absenceDaysAhead);
  const predictedFinish = new Date(i.now.getTime() + calendarDays * DAY_MS);

  if (!i.deadline) {
    return { predictedFinish, riskPct: null, level: 'green' };
  }

  const availMs = i.deadline.getTime() - i.now.getTime();
  const needMs = predictedFinish.getTime() - i.now.getTime();
  const ratio = availMs > 0 ? needMs / availMs : 2; // дедлайн в прошлом → заведомо красный
  const riskPct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  const level: RiskLevel = ratio > 1 ? 'red' : ratio >= 0.8 ? 'yellow' : 'green';
  return { predictedFinish, riskPct, level };
}

export interface OverloadInput {
  currentQueueHours: number;
  newEstimateHours: number;
  weeklyCapacityHours: number;
  riskPct: number | null;
  threshold: number;
}

export interface OverloadResult {
  warn: boolean;
  projectedHours: number;
  capacityHours: number;
  riskPct: number | null;
  reasons: string[];
}

/** Синхронный guard перегруза при назначении. */
export function computeOverload(i: OverloadInput): OverloadResult {
  const projectedHours = Math.round((Math.max(0, i.currentQueueHours) + Math.max(0, i.newEstimateHours)) * 100) / 100;
  const reasons: string[] = [];
  const overCapacity = projectedHours > i.weeklyCapacityHours;
  const overRisk = i.riskPct !== null && i.riskPct >= i.threshold;
  if (overCapacity) reasons.push(`projected ${projectedHours}h > capacity ${i.weeklyCapacityHours}h/week`);
  if (overRisk) reasons.push(`risk ${i.riskPct}% >= threshold ${i.threshold}%`);
  return { warn: overCapacity || overRisk, projectedHours, capacityHours: i.weeklyCapacityHours, riskPct: i.riskPct, reasons };
}
