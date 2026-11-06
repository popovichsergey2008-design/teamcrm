/**
 * Повторы встречи (#4787, п. 17): даты начала повторов по простому правилу.
 * Чистая функция. Время суток — местное время человека: «каждую неделю в 10:00» остаётся
 * в 10:00 и после перехода на летнее время.
 */
import { zonedParts, zonedToUtc } from './find-time';

export type RepeatFreq = 'daily' | 'weekdays' | 'weekly' | 'biweekly' | 'monthly';
export const REPEAT_FREQS: RepeatFreq[] = ['daily', 'weekdays', 'weekly', 'biweekly', 'monthly'];

/** Не больше 100 повторов и не дальше года — бесконечная серия не нужна никому. */
export function occurrences(startMs: number, freq: RepeatFreq, timeZone: string, opts: { until?: string | null; count?: number | null } = {}): number[] {
  const p = zonedParts(startMs, timeZone);
  const max = Math.min(Math.max(1, Math.round(Number(opts.count) || 100)), 100);
  const limit = startMs + 366 * 86_400_000;
  const untilMs = opts.until && /^\d{4}-\d{2}-\d{2}$/.test(opts.until)
    ? zonedToUtc(+opts.until.slice(0, 4), +opts.until.slice(5, 7), +opts.until.slice(8, 10), 23, 59, timeZone) : Infinity;
  const out: number[] = [];
  for (let i = 0; out.length < max && i < 800; i++) {
    let y = p.y; let m = p.m; let d = p.d;
    if (freq === 'monthly') {
      m = p.m + i; y = p.y + Math.floor((m - 1) / 12); m = ((m - 1) % 12) + 1;
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      if (p.d > last) continue; // 31-го в коротком месяце встречи нет
    } else {
      const step = freq === 'weekly' ? 7 : freq === 'biweekly' ? 14 : 1;
      const dt = new Date(Date.UTC(p.y, p.m - 1, p.d + i * step));
      y = dt.getUTCFullYear(); m = dt.getUTCMonth() + 1; d = dt.getUTCDate();
      if (freq === 'weekdays') { const wd = dt.getUTCDay(); if (wd === 0 || wd === 6) continue; }
    }
    const t = zonedToUtc(y, m, d, p.hh, p.mm, timeZone);
    if (t > untilMs || t > limit) break;
    out.push(t);
  }
  return out;
}
