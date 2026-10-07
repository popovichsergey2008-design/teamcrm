import { localParts } from '../assistant/ping-rules';
import { zonedTime } from '../focus/close-day';

/**
 * Календарь секретаря (ТЗ-18, §7.1–7.2) — правилами, без модели.
 *
 * Поиск окна — арифметика над занятостью: модель здесь только навредит (придумает
 * свободное время). Учитываем рабочие часы и выходные компании, отпуска и встречи
 * всех участников, буфер между встречами и то, что прошлое предлагать нельзя.
 */

export interface Busy { start: Date; end: Date; kind?: string }
export interface Work { workStart: string; workEnd: string; weekendDays: number[]; holidays: string[] }
export interface Slot { start: Date; end: Date }

/** Буфер вокруг чужих встреч: впритык поставленная встреча — это опоздание на следующую. */
export const BUFFER_MIN = 10;
const STEP_MIN = 30;
const MAX_DAYS = 21;

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Событие «весь день» — заметка (поездка, дежурство), а не занятое время: так же считает календарь. */
const blocks = (b: Busy) => b.kind !== 'all_day';

/**
 * Свободные окна для всех сразу.
 *
 * Предлагаем не больше двух окон в день: пять вариантов подряд в понедельник утром —
 * это один вариант, а не пять. Человеку нужен выбор между днями.
 */
export function findSlots(o: {
  from: Date; to: Date; durationMin: number; busy: Busy[]; work: Work; tz: string; now: Date;
  bufferMin?: number; max?: number; perDay?: number;
}): Slot[] {
  const dur = Math.max(5, Math.min(8 * 60, Math.round(o.durationMin))) * 60_000;
  const buf = (o.bufferMin ?? BUFFER_MIN) * 60_000;
  const max = o.max ?? 5;
  const perDay = o.perDay ?? 2;
  const busy = o.busy.filter(blocks).map((b) => ({ s: b.start.getTime() - buf, e: b.end.getTime() + buf }));
  const earliest = Math.max(o.from.getTime(), o.now.getTime());
  const out: Slot[] = [];
  let day = localParts(new Date(earliest), o.tz).date;
  const lastDay = localParts(o.to, o.tz).date;
  for (let i = 0; i < MAX_DAYS && day <= lastDay && out.length < max; i += 1, day = addDays(day, 1)) {
    const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (o.work.weekendDays.includes(dow) || o.work.holidays.includes(day)) continue;
    const open = zonedTime(day, o.work.workStart, o.tz).getTime();
    const close = zonedTime(day, o.work.workEnd, o.tz).getTime();
    // первая кандидатура — ближайшая «:00» или «:30» после начала дня и после «сейчас»
    let t = Math.max(open, earliest);
    const step = STEP_MIN * 60_000;
    t = Math.ceil(t / step) * step;
    let taken = 0;
    for (; t + dur <= close && taken < perDay && out.length < max; t += step) {
      const end = t + dur;
      if (busy.some((b) => b.s < end && b.e > t)) continue;
      out.push({ start: new Date(t), end: new Date(end) });
      taken += 1;
      // следующее окно этого дня — не впритык к найденному, а хотя бы через два часа
      t += 3 * step;
    }
  }
  return out;
}

export interface CalEvent { id: string; title: string; start: Date; end: Date; allDay?: boolean }

/** Пересечения встреч: пары, где одна начинается раньше, чем кончилась другая. */
export function conflicts(events: CalEvent[]): [CalEvent, CalEvent][] {
  const list = events.filter((e) => !e.allDay).sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: [CalEvent, CalEvent][] = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      if (list[j].start.getTime() >= list[i].end.getTime()) break;
      out.push([list[i], list[j]]);
    }
  }
  return out;
}

export const timeRu = (d: Date, tz: string) => d.toLocaleTimeString('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
export const dayRu = (d: Date, tz: string) => d.toLocaleDateString('ru-RU', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'long' });
export const slotRu = (s: Slot, tz: string) => `${dayRu(s.start, tz)}, ${timeRu(s.start, tz)}–${timeRu(s.end, tz)}`;
