import { localParts } from '../assistant/ping-rules';

/**
 * «Завершить день» (ТЗ-16, п. 78–87) — чистые правила, время передаётся снаружи.
 *
 * Конец дня — по рабочим часам организации; если их никто не задавал — 18:30, как
 * в ТЗ. Кнопку показываем за полчаса до конца (человек собирается уходить раньше,
 * чем часы покажут ровно 18:30) или сразу, как только вся тройка сделана.
 */
export interface WorkDay {
  workStart: string; // «09:00»
  workEnd: string;   // «18:30»
  weekendDays: number[];
  holidays: string[];
}

export const DEFAULT_DAY: WorkDay = { workStart: '09:00', workEnd: '18:30', weekendDays: [0, 6], holidays: [] };
const EARLY_MIN = 30;

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

export function closeDayAvailable(now: Date, tz: string, work: WorkDay, topDone: number, topTotal: number): boolean {
  if (topTotal > 0 && topDone >= topTotal) return true;
  const p = localParts(now, tz);
  return p.hour * 60 + p.minute >= toMin(work.workEnd) - EARLY_MIN;
}

/** Местные дата и время в поясе → момент времени. Сдвиг пояса уточняем по нему же. */
export function zonedTime(date: string, hhmm: string, tz: string): Date {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h || 0, mi || 0);
  // насколько пояс опережает UTC в этот момент
  const p = localParts(new Date(guess), tz);
  const [ly, lmo, ld] = p.date.split('-').map(Number);
  const asLocal = Date.UTC(ly, lmo - 1, ld, p.hour, p.minute);
  return new Date(guess - (asLocal - guess));
}

const addDays = (date: string, n: number) => {
  const t = Date.parse(`${date}T12:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
};
const dowOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

/**
 * Начало следующего рабочего дня человека — до него держится «день закрыт» и тихий
 * режим (п. 86–87). Выходные и праздники организации пропускаем. Закрыли день после
 * полуночи, а сегодня рабочий — значит, до сегодняшнего утра.
 */
export function nextWorkStart(now: Date, tz: string, work: WorkDay): Date {
  const today = localParts(now, tz).date;
  for (let i = 0; i < 21; i++) {
    const date = addDays(today, i);
    if (work.weekendDays.includes(dowOf(date)) || work.holidays.includes(date)) continue;
    const start = zonedTime(date, work.workStart, tz);
    if (start.getTime() > now.getTime()) return start;
  }
  return new Date(now.getTime() + 16 * 3_600_000);
}

/** Завтра по местному календарю — для «закрепить на завтра». */
export function tomorrowOf(now: Date, tz: string): string {
  return addDays(localParts(now, tz).date, 1);
}
