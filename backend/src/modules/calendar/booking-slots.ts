/**
 * Свободное время для записи по ссылке (#4787, п. 6–8).
 *
 * Чистая функция: гость видит только время, которое проходит ВСЕ правила человека —
 * часы по дням недели (с перерывами), свои дни и часы вида встречи, закрытые даты, отпуск,
 * лимит встреч в день, «не в последний момент», горизонт, перерывы до и после встречи —
 * и не пересекается с его занятостью.
 */
import { Interval, zonedParts, zonedToUtc } from './find-time';

/** {"1":[["09:00","13:00"],["14:00","18:00"]]} — день недели (0 = вс) → промежутки. */
export type Weekly = Record<string, [string, string][]>;

export interface BookingRules {
  weekly: Weekly;
  blockedDates: string[];
  vacations: { from: string; to: string }[];
  maxPerDay: number | null;
  minNoticeMin: number;
  horizonDays: number;
}

export interface BookingTypeShape {
  durationMin: number;
  weekly: Weekly | null;
  bufferBefore: number;
  bufferAfter: number;
}

export interface SlotsInput {
  now: number;
  rules: BookingRules;
  type: BookingTypeShape;
  busy: Interval[];
  /** Сколько встреч уже стоит в день (дата 'YYYY-MM-DD' в поясе человека). */
  meetingsPerDay: Record<string, number>;
  timeZone: string;
}

export interface DaySlots { date: string; slots: string[] }

const MIN = 60_000;
const toMin = (s: string) => { const [h, m] = s.split(':').map(Number); return (h || 0) * 60 + (m || 0); };

/** Пересечение двух наборов промежутков минут дня. */
function intersect(a: [number, number][], b: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [as, ae] of a) for (const [bs, be] of b) {
    const s = Math.max(as, bs);
    const e = Math.min(ae, be);
    if (e > s) out.push([s, e]);
  }
  return out;
}

const DEFAULT_WEEKLY: Weekly = { 1: [['09:00', '18:00']], 2: [['09:00', '18:00']], 3: [['09:00', '18:00']], 4: [['09:00', '18:00']], 5: [['09:00', '18:00']] };
export function defaultWeekly(workStart = '09:00', workEnd = '18:00', weekendDays: number[] = [0, 6]): Weekly {
  const w: Weekly = {};
  for (let d = 0; d < 7; d++) if (!weekendDays.includes(d)) w[String(d)] = [[workStart, workEnd]];
  return Object.keys(w).length ? w : DEFAULT_WEEKLY;
}

export function inVacation(date: string, vacations: { from: string; to: string }[]): boolean {
  return vacations.some((v) => v.from <= date && date <= v.to);
}

/** Шаг начала слотов: короткие встречи — каждые 15 минут, длинные — каждые 30. */
export const slotStep = (durationMin: number) => (durationMin <= 30 ? 15 : 30);

export function bookingSlots(input: SlotsInput): DaySlots[] {
  const { rules, type, timeZone } = input;
  const dur = type.durationMin * MIN;
  const step = slotStep(type.durationMin) * MIN;
  const earliest = input.now + rules.minNoticeMin * MIN;
  const busy = [...input.busy].sort((a, b) => a.start - b.start);
  const free = (s: number, e: number) => !busy.some((b) => b.start < e && b.end > s);
  const first = zonedParts(input.now, timeZone);
  const out: DaySlots[] = [];
  for (let i = 0; i < rules.horizonDays; i++) {
    const noon = zonedToUtc(first.y, first.m, first.d, 12, 0, timeZone) + i * 86_400_000;
    const p = zonedParts(noon, timeZone);
    if (rules.blockedDates.includes(p.date) || inVacation(p.date, rules.vacations)) continue;
    const base = (rules.weekly[String(p.weekday)] ?? []).map(([s, e]) => [toMin(s), toMin(e)] as [number, number]);
    let windows = base;
    if (type.weekly) {
      const own = (type.weekly[String(p.weekday)] ?? []).map(([s, e]) => [toMin(s), toMin(e)] as [number, number]);
      windows = intersect(base, own);
    }
    if (!windows.length) continue;
    const taken = input.meetingsPerDay[p.date] ?? 0;
    if (rules.maxPerDay != null && taken >= rules.maxPerDay) continue;
    const slots: string[] = [];
    for (const [ws, we] of windows) {
      const wStart = zonedToUtc(p.y, p.m, p.d, Math.floor(ws / 60), ws % 60, timeZone);
      const wEnd = zonedToUtc(p.y, p.m, p.d, Math.floor(we / 60), we % 60, timeZone);
      for (let s = wStart; s + dur <= wEnd; s += step) {
        if (s < earliest) continue;
        if (!free(s - type.bufferBefore * MIN, s + dur + type.bufferAfter * MIN)) continue;
        slots.push(new Date(s).toISOString());
      }
    }
    if (slots.length) out.push({ date: p.date, slots });
  }
  return out;
}

/** Проверка одного выбранного гостем времени — тем же правилом, что и показ (п. 6, 15). */
export function slotAllowed(input: SlotsInput, startsAt: number): boolean {
  const iso = new Date(startsAt).toISOString();
  return bookingSlots(input).some((d) => d.slots.includes(iso));
}
