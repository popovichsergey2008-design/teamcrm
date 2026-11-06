/**
 * «Найти время для задачи» (#4787, п. 5) и основа «Помоги спланировать день» (п. 14).
 *
 * Чистая функция без базы: правило подбора читается целиком и проверяется тестами.
 * Окно не ставится поверх встречи и не уходит за срок — дедлайн без разрешения не двигаем.
 * Время считается в часовом поясе человека: «рабочие часы с 9 до 18» — это его 9 утра.
 */

export interface Interval { start: number; end: number }

export interface WorkHours {
  workStart: string; // 'HH:MM'
  workEnd: string;
  weekendDays: number[]; // 0 — воскресенье
  holidays: string[];   // 'YYYY-MM-DD'
}

export interface FindTimeInput {
  now: number;
  minutes: number;
  /** Срок задачи; нет — ищем на горизонте. */
  deadline: number | null;
  busy: Interval[];
  work: WorkHours;
  timeZone: string;
  /** Сколько дней вперёд смотреть, если срока нет (и потолок при сроке). */
  horizonDays?: number;
  /** Сколько вариантов предложить. */
  limit?: number;
  /** Шаг начала окна, минут: окна начинаются в «круглое» время. */
  stepMin?: number;
}

export interface TimeOption { startsAt: string; endsAt: string; note: string }

export interface FindTimeResult {
  options: TimeOption[];
  /** Окна нет — объяснение человеческими словами. */
  message: string | null;
}

const MIN = 60_000;

/** Части местного времени момента в поясе tz. */
export function zonedParts(ms: number, timeZone: string) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, weekday: wd, date: `${p.year}-${p.month}-${p.day}` };
}

/** Местное «Y-M-D HH:MM» в поясе tz → момент UTC (с учётом перехода на летнее время). */
export function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, timeZone: string): number {
  let guess = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(guess, timeZone);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
    guess += Date.UTC(y, m - 1, d, hh, mm) - asUtc;
  }
  return guess;
}

const hm = (s: string) => { const [h, m] = s.split(':').map(Number); return { h: h || 0, m: m || 0 }; };

/** Рабочие промежутки по дням от `from` на `days` дней вперёд, в UTC. */
export function workWindows(from: number, days: number, work: WorkHours, timeZone: string): Interval[] {
  const out: Interval[] = [];
  const s = hm(work.workStart);
  const e = hm(work.workEnd);
  const first = zonedParts(from, timeZone);
  for (let i = 0; i < days; i++) {
    // полдень местного дня — так сдвиг на сутки не споткнётся о переход времени
    const noon = zonedToUtc(first.y, first.m, first.d, 12, 0, timeZone) + i * 86_400_000;
    const p = zonedParts(noon, timeZone);
    if (work.weekendDays.includes(p.weekday) || work.holidays.includes(p.date)) continue;
    const start = zonedToUtc(p.y, p.m, p.d, s.h, s.m, timeZone);
    const end = zonedToUtc(p.y, p.m, p.d, e.h, e.m, timeZone);
    if (end > start) out.push({ start, end });
  }
  return out;
}

/** Свободные куски рабочего времени: рабочие окна минус занятость. */
export function freeSlots(windows: Interval[], busy: Interval[]): Interval[] {
  const sorted = [...busy].filter((b) => b.end > b.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const w of windows) {
    let cur = w.start;
    for (const b of sorted) {
      if (b.end <= cur || b.start >= w.end) continue;
      if (b.start > cur) out.push({ start: cur, end: Math.min(b.start, w.end) });
      cur = Math.max(cur, b.end);
      if (cur >= w.end) break;
    }
    if (cur < w.end) out.push({ start: cur, end: w.end });
  }
  return out;
}

const fmtMin = (n: number) => (n % 60 === 0 && n >= 60 ? `${n / 60} ч` : `${n} минут`);

export function findTime(input: FindTimeInput): FindTimeResult {
  const minutes = Math.max(5, Math.min(Math.round(input.minutes), 8 * 60));
  const step = (input.stepMin ?? 10) * MIN;
  const limit = input.limit ?? 3;
  const horizon = input.horizonDays ?? 14;
  const need = minutes * MIN;
  // начинаем не раньше ближайшего «круглого» времени: 10:07 → 10:10
  const startFrom = Math.ceil((input.now + MIN) / step) * step;
  const until = input.deadline != null ? Math.min(input.deadline, input.now + horizon * 86_400_000) : input.now + horizon * 86_400_000;
  if (input.deadline != null && input.deadline <= startFrom) {
    return { options: [], message: 'Срок задачи уже прошёл — выберите время вручную или сначала пересмотрите срок.' };
  }
  const days = Math.ceil((until - input.now) / 86_400_000) + 1;
  const windows = workWindows(input.now, days, input.work, input.timeZone)
    .map((w) => ({ start: Math.max(w.start, startFrom), end: Math.min(w.end, until) }))
    .filter((w) => w.end > w.start);
  const free = freeSlots(windows, input.busy);
  const busySorted = [...input.busy].sort((a, b) => a.start - b.start);

  const options: TimeOption[] = [];
  const usedDays = new Set<string>();
  // сначала — по одному варианту на день (выбор, а не три окна подряд), потом добиваем
  for (const pass of [0, 1]) {
    for (const f of free) {
      if (options.length >= limit) break;
      const start = Math.ceil(f.start / step) * step;
      if (start + need > f.end) continue;
      const day = zonedParts(start, input.timeZone).date;
      if (pass === 0 && usedDays.has(day)) continue;
      if (options.some((o) => Date.parse(o.startsAt) === start)) continue;
      usedDays.add(day);
      const end = start + need;
      const next = busySorted.find((b) => b.start >= end);
      const note = next && next.start - end <= 30 * MIN && zonedParts(next.start, input.timeZone).date === day
        ? 'Есть свободное окно до следующего звонка.'
        : input.deadline != null
          ? 'Подходит по рабочим часам, задача будет выполнена до срока.'
          : 'Подходит по рабочим часам.';
      options.push({ startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), note });
    }
  }
  options.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  if (options.length) return { options, message: null };
  return {
    options: [],
    message: input.deadline != null
      ? `До срока нет свободного окна на ${fmtMin(minutes)}. Можно разделить работу на два подхода или пересмотреть план.`
      : `В ближайшие ${horizon} дней нет свободного окна на ${fmtMin(minutes)}. Можно разделить работу на два подхода.`,
  };
}
