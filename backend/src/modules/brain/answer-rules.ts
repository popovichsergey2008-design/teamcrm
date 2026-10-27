import { instrumental } from '../../common/text/ru-names';
import { localParts } from '../assistant/ping-rules';
import { zonedTime } from '../focus/close-day';
import { clock } from '../knowledge/memory-rules';

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * «Второй мозг» (#1525, фича 3) — чистые правила ответа без базы и модели:
 * период из вопроса («в августе»), подпись фрагмента созвона («14 августа на 12-й минуте
 * созвона с Константином») и ссылка «Вот ссылка на созвон с воспроизведением с 12:15».
 */

const MONTH_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
/** «в августе» */
const MONTH_PREP = ['январе', 'феврале', 'марте', 'апреле', 'мае', 'июне', 'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре'];
/** «за август» */
const MONTH_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

export interface Period { from: Date; to: Date; label: string }

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const nextMonth = (y: number, m: number) => (m === 12 ? [y + 1, 1] : [y, m + 1]) as [number, number];

/**
 * Период источника из слов вопроса — в поясе компании. Месяц без года — последний
 * прошедший: в октябре «в августе» — этот год, «в ноябре» — прошлый.
 */
export function periodOf(question: string, now: Date, tz: string): Period | null {
  const q = question.toLowerCase().replace(/ё/g, 'е');
  const today = localParts(now, tz).date;
  const [cy, cm] = today.split('-').map(Number);
  const range = (fromDate: string, toDate: string, label: string): Period => ({
    from: zonedTime(fromDate, '00:00', tz), to: zonedTime(toDate, '00:00', tz), label,
  });
  const yearOf = (m: number, y?: string) => (y ? Number(y) : m > cm ? cy - 1 : cy);
  const word = (forms: string[]) => `(${forms.join('|')})`;
  const edge = '(?![\\p{L}])';

  // «14 августа», «3 мая 2025»
  const day = q.match(new RegExp(`(?<![\\p{N}])(\\d{1,2})\\s+${word(MONTH_GEN)}${edge}(?:\\s+(\\d{4}))?`, 'u'));
  if (day) {
    const m = MONTH_GEN.indexOf(day[2]) + 1;
    const d = Number(day[1]);
    if (d >= 1 && d <= 31) {
      const y = yearOf(m, day[3]);
      const from = ymd(y, m, d);
      return range(from, addDays(from, 1), `${d} ${MONTH_GEN[m - 1]}`);
    }
  }
  // «в августе», «за август», «в августе 2025»
  const month = q.match(new RegExp(`(?<![\\p{L}])(?:в|во|за)\\s+(?:${word(MONTH_PREP)}|${word(MONTH_NOM)})${edge}(?:\\s+(\\d{4}))?`, 'u'));
  if (month) {
    const m = (month[1] ? MONTH_PREP.indexOf(month[1]) : MONTH_NOM.indexOf(month[2])) + 1;
    const y = yearOf(m, month[3]);
    const [ny, nm] = nextMonth(y, m);
    return range(ymd(y, m, 1), ymd(ny, nm, 1), `${MONTH_NOM[m - 1]}${month[3] ? ` ${y}` : ''}`);
  }
  if (/(?:в|за)\s+прошл(?:ом|ый)\s+месяц/u.test(q)) {
    const [py, pm] = cm === 1 ? [cy - 1, 12] : [cy, cm - 1];
    return range(ymd(py, pm, 1), ymd(cy, cm, 1), 'прошлый месяц');
  }
  if (/(?:в|за)\s+эт(?:ом|от)\s+месяц/u.test(q)) return range(ymd(cy, cm, 1), addDays(today, 1), 'этот месяц');
  const dow = localParts(now, tz).dow || 7; // пн = 1 … вс = 7
  const monday = addDays(today, 1 - dow);
  if (/(?:на|за)\s+прошл(?:ой|ую)\s+недел/u.test(q)) return range(addDays(monday, -7), monday, 'прошлую неделю');
  if (/(?:на|за)\s+эт(?:ой|у)\s+недел/u.test(q)) return range(monday, addDays(today, 1), 'эту неделю');
  if (/(?<![\p{L}])позавчера(?![\p{L}])/u.test(q)) return range(addDays(today, -2), addDays(today, -1), 'позавчера');
  if (/(?<![\p{L}])вчера(?![\p{L}])/u.test(q)) return range(addDays(today, -1), today, 'вчера');
  if (/(?<![\p{L}])сегодня(?![\p{L}])/u.test(q)) return range(today, addDays(today, 1), 'сегодня');
  const year = q.match(/(?:в|за)\s+(\d{4})\s+год/u);
  if (year) return range(`${year[1]}-01-01`, `${Number(year[1]) + 1}-01-01`, `${year[1]} год`);
  if (/(?:в|за)\s+прошл(?:ом|ый)\s+год/u.test(q)) return range(`${cy - 1}-01-01`, `${cy}-01-01`, 'прошлый год');
  return null;
}

/** «14 августа»; другой год — «14 августа 2025». */
export function spokenDate(at: Date, now: Date, tz: string): string {
  const [y, m, d] = localParts(at, tz).date.split('-').map(Number);
  const cy = Number(localParts(now, tz).date.slice(0, 4));
  return `${d} ${MONTH_GEN[m - 1]}${y !== cy ? ` ${y}` : ''}`;
}

/** «на 12-й минуте»: минута записи, как её называют люди (12:15 → 12-я). */
export function minuteWord(sec: number): string {
  return `на ${Math.max(1, Math.floor(Math.max(0, sec) / 60))}-й минуте`;
}

const NOT_A_PERSON = /^(спикер|speaker|гость|участник|unknown|неизвестн)/i;

/**
 * С кем был созвон в этом месте записи: тот, кто говорил (кроме спрашивающего). Имена
 * — из подписи реплик «[12:15] Константин: …»; «Спикер 1» именем не считаем.
 */
export function participantOf(snippet: string, author: string | null, viewerName: string | null): string | null {
  const me = (viewerName ?? '').trim().toLowerCase();
  const same = (n: string) => !!me && (n.toLowerCase() === me || n.toLowerCase().split(/\s+/)[0] === me.split(/\s+/)[0]);
  const names = [author, ...[...snippet.matchAll(/\[\d+(?::\d\d){1,2}\]\s+([^:\n[\]]{2,60}):/g)].map((m) => m[1].trim())]
    .filter((n): n is string => !!n && !NOT_A_PERSON.test(n));
  return names.find((n) => !same(n)) ?? null;
}

/** Подпись фрагмента созвона для ответа: «14 августа на 12-й минуте созвона с Константином». */
export function meetingLead(at: Date, sec: number, participant: string | null, now: Date, tz: string): string {
  const who = participant ? ` с ${instrumental(participant)}` : '';
  return `${spokenDate(at, now, tz)} ${minuteWord(sec)} созвона${who}`;
}

/** «Вот ссылка на созвон с воспроизведением с 12:15». */
export const playLabel = (sec: number) => `Вот ссылка на созвон с воспроизведением с ${clock(sec)}`;

export interface CitedSource { sourceType: string; link?: string | null; sec?: number | null }
export interface Shaped { text: string; play: { link: string; label: string } | null }

/**
 * Ответ формой документа: номера источников [n] убираем (под ответом — ссылки), ссылку
 * на запись даём сами — из ПЕРВОГО процитированного фрагмента созвона с секундой.
 * Модель свою «вот ссылка…» дописать могла — её заменяем, чтобы ссылка была одна и живая.
 */
export function shapeAnswer(raw: string, sources: CitedSource[]): Shaped {
  const cited = [...raw.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]) - 1);
  const isRec = (s: CitedSource | undefined) => !!s && s.sourceType === 'meeting' && s.sec != null && !!s.link;
  // модель назвала «…на 12-й минуте созвона», но номер [n] не поставила — ссылка всё равно
  // нужна (документ: «Вот ссылка на созвон…»): берём первый фрагмент созвона из найденного
  const pick = cited.map((i) => sources[i]).find(isRec)
    ?? (!cited.length && /минуте\s+созвона/u.test(raw) ? sources.find(isRec) : undefined);
  const text = raw
    .replace(/\s*Вот ссылка на (?:созвон|запись)[^.\n]*\.?/giu, '')
    .replace(/\s*\[\d+\](?:\s*,?\s*\[\d+\])*/g, '')
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .trim();
  return {
    text,
    play: pick ? { link: String(pick.link), label: playLabel(Number(pick.sec)) } : null,
  };
}
