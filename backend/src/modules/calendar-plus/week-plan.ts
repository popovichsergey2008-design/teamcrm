/**
 * Время работает на задачи (#4892, п. 8–9). Чистые правила без базы:
 *  - «Разложить по неделе»: задачи — в свободные окна до своих сроков, с учётом оценки;
 *    сроки не меняются, поверх встреч не ставим (жалоба на Motion);
 *  - цель фокуса на неделю: блоки в лучшие окна — утро, от 2 часов;
 *  - встречу поставили на фокус — блок переезжает в ближайшее свободное окно того же дня.
 */
import { freeSlots, Interval, workWindows, WorkHours, zonedParts } from '../calendar/find-time';

const MIN = 60_000;

export interface PlanTaskIn { id: string; title: string; deadline: number | null; estimateMin: number | null }
export interface Placement { taskId: string; title: string; start: number; end: number }

export interface WeekCtx {
  now: number;
  from: number;
  to: number;
  timeZone: string;
  work: WorkHours;
  lunch?: { start: string; end: string } | null;
  /** Занятость: встречи, уже стоящие блоки, внешние события. */
  busy: Interval[];
}

function lunchSpans(ctx: WeekCtx): Interval[] {
  if (!ctx.lunch) return [];
  const days = Math.ceil((ctx.to - ctx.from) / 86_400_000) + 1;
  return workWindows(ctx.from, days, { ...ctx.work, workStart: ctx.lunch.start, workEnd: ctx.lunch.end }, ctx.timeZone);
}

/** Свободные окна недели в рабочих часах: минус встречи, блоки и обед. */
export function weekFree(ctx: WeekCtx): Interval[] {
  const days = Math.ceil((ctx.to - ctx.from) / 86_400_000) + 1;
  const step = 15 * MIN;
  const start = Math.ceil((Math.max(ctx.now, ctx.from) + 5 * MIN) / step) * step;
  const windows = workWindows(ctx.from, days, ctx.work, ctx.timeZone)
    .map((w) => ({ start: Math.max(w.start, start), end: Math.min(w.end, ctx.to) }))
    .filter((w) => w.end > w.start);
  return freeSlots(windows, [...ctx.busy, ...lunchSpans(ctx)]).filter((f) => f.end - f.start >= 30 * MIN);
}

/**
 * «Разложить по неделе»: срочные — первыми; каждая задача — в самое раннее окно, где
 * помещается её оценка (нет оценки — час) и которое заканчивается до срока. Не влезла
 * целиком — пробуем двумя подходами по половине. Не влезла совсем — честно в unplaced.
 */
export function planWeek(ctx: WeekCtx, tasks: PlanTaskIn[], breakMin = 10): { placements: Placement[]; unplaced: string[] } {
  let free = weekFree(ctx).map((f) => ({ ...f }));
  const placements: Placement[] = [];
  const unplaced: string[] = [];
  const order = [...tasks].sort((a, b) => (a.deadline ?? Infinity) - (b.deadline ?? Infinity));
  const take = (len: number, until: number | null): Interval | null => {
    const slot = free.find((f) => f.end - f.start >= len && (until == null || f.start + len <= until));
    if (!slot) return null;
    const out = { start: slot.start, end: slot.start + len };
    slot.start = out.end + breakMin * MIN;
    free = free.filter((f) => f.end - f.start >= 30 * MIN);
    return out;
  };
  for (const t of order) {
    const len = Math.max(30, Math.min(240, t.estimateMin ?? 60)) * MIN;
    const one = take(len, t.deadline);
    if (one) { placements.push({ taskId: t.id, title: t.title, ...one }); continue; }
    if (len >= 60 * MIN) {
      const half = Math.ceil(len / 2 / (15 * MIN)) * 15 * MIN;
      const a = take(half, t.deadline);
      const b = a ? take(half, t.deadline) : null;
      if (a && b) { placements.push({ taskId: t.id, title: t.title, ...a }, { taskId: t.id, title: t.title, ...b }); continue; }
      if (a) placements.push({ taskId: t.id, title: t.title, ...a });
      else unplaced.push(t.id);
      continue;
    }
    unplaced.push(t.id);
  }
  return { placements: placements.sort((a, b) => a.start - b.start), unplaced };
}

/**
 * Цель фокуса: добрать `needMin` блоками в лучшие окна — утро первым, от 2 часов
 * (короче — только если длинных не осталось), не больше одного блока в день, пока
 * хватает дней.
 */
export function focusFill(ctx: WeekCtx, needMin: number, blockMin = 120): Interval[] {
  if (needMin <= 0) return [];
  const free = weekFree(ctx);
  const morning = (f: Interval) => zonedParts(f.start, ctx.timeZone).hh < 13;
  const ranked = [...free].sort((a, b) => {
    const la = a.end - a.start >= blockMin * MIN ? 0 : 1;
    const lb = b.end - b.start >= blockMin * MIN ? 0 : 1;
    return la - lb || (morning(a) ? 0 : 1) - (morning(b) ? 0 : 1) || a.start - b.start;
  });
  const out: Interval[] = [];
  const usedDays = new Set<string>();
  let left = needMin * MIN;
  for (const pass of [0, 1]) {
    for (const f of ranked) {
      if (left <= 0) break;
      const day = zonedParts(f.start, ctx.timeZone).date;
      if (pass === 0 && usedDays.has(day)) continue;
      if (out.some((o) => o.start < f.end && o.end > f.start)) continue;
      const len = Math.min(f.end - f.start, Math.max(60 * MIN, Math.min(blockMin * MIN, left)));
      if (len < 60 * MIN) continue;
      out.push({ start: f.start, end: f.start + len });
      usedDays.add(day);
      left -= len;
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Встречу поставили на фокус: ближайшее свободное окно того же дня той же длины
 * (не уже часа). Нет — null: блок остаётся, человеку говорим прямо.
 */
export function relocate(block: Interval, ctx: WeekCtx): Interval | null {
  const len = block.end - block.start;
  const day = zonedParts(block.start, ctx.timeZone).date;
  const free = weekFree(ctx).filter((f) => zonedParts(f.start, ctx.timeZone).date === day);
  const fit = free.filter((f) => f.end - f.start >= Math.min(len, 60 * MIN))
    .sort((a, b) => Math.abs(a.start - block.start) - Math.abs(b.start - block.start))[0];
  if (!fit) return null;
  const l = Math.min(len, fit.end - fit.start);
  // окно после блока — с его начала; окно до — вплотную к прежнему месту
  const start = fit.end <= block.start ? fit.end - l : fit.start;
  return { start, end: start + l };
}
