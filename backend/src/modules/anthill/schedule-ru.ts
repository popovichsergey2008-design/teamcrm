/**
 * Расписание из русской фразы — правилами, без модели (ТЗ-6, разд. 15).
 *
 * Почему не модель: «каждый понедельник в 9:00» разбирается десятком правил и
 * никогда не ошибается, а модель раз в сотню ответов поставит вторник — и человек
 * узнает об этом через неделю, когда отчёт не придёт. Модель нужна там, где есть
 * смысл, а здесь есть только календарь.
 *
 * ГРАБЛИ: `\b` и `\w` в JS не видят кириллицу — границы слов проверяем явными
 * классами, как в разборе диктовки (см. nl).
 */

export type ScheduleKind = 'daily' | 'weekdays' | 'weekly' | 'monthly';

export interface Schedule {
  kind: ScheduleKind;
  /** Местное время запуска, «09:00». */
  time: string;
  /** Для weekly: 1 — понедельник … 7 — воскресенье. */
  weekday?: number;
  /** Для monthly: число месяца, 1–28 (29–31 есть не в каждом месяце). */
  day?: number;
}

const WEEKDAYS: { re: RegExp; n: number }[] = [
  { re: /понедельник/i, n: 1 },
  { re: /вторник/i, n: 2 },
  { re: /сред[ауые]/i, n: 3 },
  { re: /четверг/i, n: 4 },
  { re: /пятниц[ауые]/i, n: 5 },
  { re: /суббот[ауые]/i, n: 6 },
  { re: /воскресень[еяю]/i, n: 7 },
];

/** «каждый понедельник», но «каждую среду» и «каждое воскресенье» — род решает предлог. */
const EVERY_WEEKDAY = ['', 'каждый понедельник', 'каждый вторник', 'каждую среду', 'каждый четверг', 'каждую пятницу', 'каждую субботу', 'каждое воскресенье'];

/** Время суток словами — то, что люди называют вместо часов. */
const PARTS_OF_DAY: { re: RegExp; time: string }[] = [
  { re: /(рано утром|с утра пораньше)/i, time: '07:00' },
  { re: /(утром|по утрам|каждое утро|утренн)/i, time: '09:00' },
  { re: /(в обед|днём|днем)/i, time: '13:00' },
  { re: /(вечером|по вечерам|каждый вечер|вечерн)/i, time: '18:00' },
  { re: /(ночью|поздно вечером)/i, time: '22:00' },
];

const pad = (n: number) => String(n).padStart(2, '0');

/** «в 9», «в 9:00», «в 17.30», «к 10 утра» → «09:00». */
function findTime(text: string): string | null {
  const m = /(?:в|к|на)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(утра|дня|вечера|ночи)?/i.exec(text);
  if (m) {
    let hour = Number(m[1]);
    const minute = m[2] ? Number(m[2]) : 0;
    const part = (m[3] ?? '').toLowerCase();
    if (part === 'вечера' && hour < 12) hour += 12;
    if (part === 'дня' && hour < 12 && hour >= 1 && hour <= 5) hour += 12;
    if (part === 'ночи' && hour === 12) hour = 0;
    if (hour <= 23 && minute <= 59) return `${pad(hour)}:${pad(minute)}`;
  }
  for (const p of PARTS_OF_DAY) if (p.re.test(text)) return p.time;
  return null;
}

/**
 * Разобрать фразу. Возвращает null, если о повторении речи не шло, — тогда это
 * обычная просьба, а не регулярная задача, и придумывать ей расписание нельзя.
 */
export function parseSchedule(raw: string, fallbackTime = '09:00'): Schedule | null {
  // неразрывный пробел прилетает из диктовки и из скопированного текста — иначе правила его не узнают
  const text = String(raw ?? '').toLowerCase().replace(/\u00a0/g, ' ');
  const repeats = /(кажд|ежедневн|еженедельн|ежемесячн|по будням|по рабочим|каждую|каждое|каждый|раз в)/i.test(text);
  if (!repeats) return null;
  const time = findTime(text) ?? fallbackTime;

  if (/(по будням|будн|рабоч[а-я]+ (день|дня|дни|дней))/i.test(text)) return { kind: 'weekdays', time };

  for (const w of WEEKDAYS) {
    if (w.re.test(text)) return { kind: 'weekly', time, weekday: w.n };
  }

  const month = /(кажд(ый|ого) месяц|ежемесячн|раз в месяц)/i.test(text);
  if (month) {
    const d = /(\d{1,2})\s*числ/i.exec(text);
    const day = d ? Math.min(28, Math.max(1, Number(d[1]))) : 1;
    return { kind: 'monthly', time, day };
  }

  const week = /(кажд(ую|ый) недел|еженедельн|раз в недел)/i.test(text);
  if (week) return { kind: 'weekly', time, weekday: 1 };

  return { kind: 'daily', time };
}

/** Подпись для человека: «каждый понедельник в 9:00». */
export function scheduleLabel(s: Schedule): string {
  const at = `в ${s.time.replace(/^0/, '')}`;
  if (s.kind === 'daily') return `каждый день ${at}`;
  if (s.kind === 'weekdays') return `по будням ${at}`;
  if (s.kind === 'monthly') return `${s.day ?? 1} числа каждого месяца ${at}`;
  return `${EVERY_WEEKDAY[s.weekday ?? 1]} ${at}`;
}

/**
 * Смещение пояса в этот момент — миллисекундами.
 *
 * Считаем через Intl, а не таблицей: перевод часов и политические решения о поясах
 * живут в движке, и держать свою копию значит однажды опоздать на час.
 */
function offsetMs(at: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value])) as Record<string, string>;
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return asUtc - at.getTime();
}

/** Местная дата в поясе: {y, m, d, dow 1..7}. */
function localDate(at: Date, tz: string) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  });
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value])) as Record<string, string>;
  const dows: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), dow: dows[String(p.weekday)] ?? 1 };
}

/** Местные дата+время → момент в UTC. */
function toUtc(y: number, m: number, d: number, time: string, tz: string): Date {
  const [hh, mm] = time.split(':').map(Number);
  const naive = new Date(Date.UTC(y, m - 1, d, hh, mm, 0));
  return new Date(naive.getTime() - offsetMs(naive, tz));
}

const DAY_MS = 86_400_000;

/**
 * Когда запускать в следующий раз — строго ПОСЛЕ `after`.
 *
 * Идём по местным суткам вперёд и берём первые подходящие: так одинаково работают
 * и «по будням», и «5 числа», и перевод часов — без арифметики на смещениях.
 */
export function nextRun(s: Schedule, after: Date, tz: string | null): Date {
  const zone = tz || 'Europe/Moscow';
  for (let i = 0; i <= 400; i += 1) {
    const probe = new Date(after.getTime() + i * DAY_MS);
    const { y, m, d, dow } = localDate(probe, zone);
    const fits = s.kind === 'daily'
      || (s.kind === 'weekdays' && dow <= 5)
      || (s.kind === 'weekly' && dow === (s.weekday ?? 1))
      || (s.kind === 'monthly' && d === (s.day ?? 1));
    if (!fits) continue;
    const at = toUtc(y, m, d, s.time, zone);
    if (at.getTime() > after.getTime()) return at;
  }
  // Сюда не добраться: за 400 суток встречается любой день месяца и любой день недели.
  return new Date(after.getTime() + DAY_MS);
}
