/**
 * Утренний план «Фокуса дня» (#4891, п. 1, 1а): ёмкость дня и таймлайн. Чистая функция:
 * рабочий день − встречи = доступно; запланировано и резерв; задачи — в свободных окнах
 * между встречами; цифры сходятся арифметически, встречи вычитаются один раз.
 */
import { freeSlots, Interval, zonedToUtc } from '../calendar/find-time';

const MIN = 60_000;

export interface PlanItemIn {
  id: string; taskId: string | null; title: string; kind: 'task' | 'review' | 'approval';
  estimateMin: number | null; rank: number; done: boolean;
  /** Блок этой задачи в календаре на сегодня — тогда ставим её туда, где он стоит. */
  block?: Interval | null;
}

export interface DayPlanInput {
  now: number;
  date: string; // YYYY-MM-DD в поясе человека
  timeZone: string;
  workStart: string; workEnd: string;
  lunchStart?: string | null; lunchEnd?: string | null;
  meetings: { title: string; start: number; end: number }[];
  /** Прочие блоки календаря (фокус, время на задачи вне плана) — тоже занятость. */
  otherBlocks: Interval[];
  items: PlanItemIn[];
  /** Проверки и решения — одним блоком (п. 4). */
  reviews: number;
}

export interface Slot {
  kind: 'meeting' | 'task' | 'reviews' | 'reserve' | 'lunch';
  title: string;
  start: number; end: number;
  itemId?: string; taskId?: string | null;
  /** Оценки нет — 1 ч и пометка «≈» (п. 1). */
  estimated?: boolean;
  count?: number;
}

export interface DayPlan {
  workMin: number;
  meetingMin: number;
  availableMin: number;
  plannedMin: number;
  reviewsMin: number;
  reserveMin: number;
  /** На сколько задач больше, чем свободного времени (п. 1а). */
  overloadMin: number;
  timeline: Slot[];
  /** Задачи, которым не нашлось окна, — по рангу. */
  unplaced: string[];
}

const hm = (s: string | null | undefined) => { const [h, m] = String(s ?? '').split(':').map(Number); return { h: h || 0, m: m || 0 }; };
const union = (list: Interval[]) => {
  const s = [...list].filter((x) => x.end > x.start).sort((a, b) => a.start - b.start);
  let n = 0; let cs = -1; let ce = -1;
  for (const x of s) { if (x.start > ce) { if (ce > cs) n += ce - cs; cs = x.start; ce = x.end; } else ce = Math.max(ce, x.end); }
  if (ce > cs) n += ce - cs;
  return n;
};

/** Сколько минут на проверки: по 6 минут на штуку, не меньше 15 и не больше 2 ч. */
export const reviewsMinutes = (n: number) => (n > 0 ? Math.max(15, Math.min(120, Math.round(n * 6 / 5) * 5)) : 0);

export function dayPlan(input: DayPlanInput): DayPlan {
  const [y, mo, d] = input.date.split('-').map(Number);
  const ws = hm(input.workStart); const we = hm(input.workEnd);
  const dayStart = zonedToUtc(y, mo, d, ws.h, ws.m, input.timeZone);
  const dayEnd = zonedToUtc(y, mo, d, we.h, we.m, input.timeZone);
  let lunch: Interval | null = null;
  if (input.lunchStart && input.lunchEnd) {
    const ls = hm(input.lunchStart); const le = hm(input.lunchEnd);
    const a = zonedToUtc(y, mo, d, ls.h, ls.m, input.timeZone);
    const b = zonedToUtc(y, mo, d, le.h, le.m, input.timeZone);
    if (b > a) lunch = { start: Math.max(a, dayStart), end: Math.min(b, dayEnd) };
  }
  const clip = (x: Interval) => ({ start: Math.max(x.start, dayStart), end: Math.min(x.end, dayEnd) });
  const meetings = input.meetings.map((m) => ({ ...m, ...clip(m) })).filter((m) => m.end > m.start);
  // рабочий день — без обеда; встречи — объединением, накладка не считается дважды
  const workMin = Math.round(((dayEnd - dayStart) - (lunch ? lunch.end - lunch.start : 0)) / MIN);
  const meetingMs = union(meetings.map((m) => ({ start: m.start, end: m.end })).map((m) => (lunch ? splitOut(m, lunch) : [m])).flat());
  const meetingMin = Math.round(meetingMs / MIN);
  const availableMin = Math.max(0, workMin - meetingMin);

  const timeline: Slot[] = meetings.map((m) => ({ kind: 'meeting' as const, title: m.title, start: m.start, end: m.end }));
  if (lunch) timeline.push({ kind: 'lunch', title: 'Обед', start: lunch.start, end: lunch.end });

  const tasks = input.items.filter((i) => !i.done && (i.kind === 'task' || i.kind === 'review') && i.taskId).sort((a, b) => a.rank - b.rank);
  const busy: Interval[] = [...meetings, ...input.otherBlocks.map(clip), ...(lunch ? [lunch] : [])];
  // задачи, у которых уже есть блок в календаре, стоят там же — «это те же блоки» (ТЗ календаря, п. 8)
  for (const t of tasks) if (t.block) busy.push(clip(t.block));
  const from = Math.max(dayStart, Math.ceil((input.now + MIN) / (5 * MIN)) * 5 * MIN);
  let free = freeSlots(from < dayEnd ? [{ start: from, end: dayEnd }] : [], busy).map((f) => ({ ...f }));
  const take = (len: number, notBefore = 0): Interval | null => {
    const f = free.find((x) => Math.max(x.start, notBefore) + len <= x.end);
    if (!f) return null;
    const s = Math.max(f.start, notBefore);
    const out = { start: s, end: s + len };
    // отрезаем занятое из окна
    free = free.flatMap((x) => (x !== f ? [x] : [{ start: x.start, end: s }, { start: s + len, end: x.end }])).filter((x) => x.end - x.start >= 5 * MIN);
    return out;
  };

  let plannedMs = 0;
  const unplaced: string[] = [];
  for (const t of tasks) {
    const len = (t.estimateMin ?? 60) * MIN;
    plannedMs += len;
    const at = t.block ? clip(t.block) : take(len);
    if (!at) { unplaced.push(t.id); continue; }
    timeline.push({ kind: 'task', title: t.title, start: at.start, end: at.end, itemId: t.id, taskId: t.taskId, estimated: t.estimateMin == null });
  }
  const reviewsMin = reviewsMinutes(input.reviews);
  if (reviewsMin) {
    // блок проверок — во второй половине дня, если там есть место
    const afternoon = zonedToUtc(y, mo, d, 15, 0, input.timeZone);
    const at = take(reviewsMin * MIN, afternoon) ?? take(reviewsMin * MIN);
    if (at) timeline.push({ kind: 'reviews', title: 'Проверки и решения', start: at.start, end: at.end, count: input.reviews });
  }
  const plannedMin = Math.round(plannedMs / MIN);
  const reserveMin = Math.max(0, availableMin - plannedMin - reviewsMin);
  const overloadMin = Math.max(0, plannedMin + reviewsMin - availableMin);
  const reserve = free.filter((f) => f.end - f.start >= 30 * MIN).sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
  if (reserve && reserveMin > 0) timeline.push({ kind: 'reserve', title: 'резерв', start: reserve.start, end: Math.min(reserve.end, reserve.start + reserveMin * MIN) });
  return {
    workMin, meetingMin, availableMin, plannedMin, reviewsMin, reserveMin, overloadMin,
    timeline: timeline.sort((a, b) => a.start - b.start), unplaced,
  };
}

/** Встреча минус обед — время обеда не считается встречей дважды. */
function splitOut(m: Interval, lunch: Interval): Interval[] {
  if (m.end <= lunch.start || m.start >= lunch.end) return [m];
  return [{ start: m.start, end: lunch.start }, { start: lunch.end, end: m.end }].filter((x) => x.end > x.start);
}

/** Короткое название для брифа (п. 2): до 60 знаков, без «Проверить и принять: …», без обрыва посреди слова. */
export function shortTitle(t: string, max = 60): string {
  const s = String(t ?? '').replace(/^(проверить и принять|согласовать)\s*:\s*/i, '').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:\s—-]+$/, '');
}

export const hours = (min: number) => {
  const h = Math.floor(min / 60); const m = min % 60;
  return h && m ? `${h} ч ${m} мин` : h ? `${h} ч` : `${m} мин`;
};
