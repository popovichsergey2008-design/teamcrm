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

export interface PlanDayInput {
  now: number;
  /** День плана — 'YYYY-MM-DD' в поясе человека. */
  date: string;
  items: { id: string; minutes: number }[];
  busy: Interval[];
  work: WorkHours;
  timeZone: string;
  /** Перерыв между подходами, минут. */
  breakMin?: number;
}

export interface PlanDayResult {
  plan: { id: string; startsAt: string; endsAt: string }[];
  unplaced: string[];
  needMin: number;
  freeMin: number;
  message: string | null;
}

/**
 * «Помоги спланировать день» (#4787, п. 14): задачи — в свободные окна дня по порядку,
 * с перерывами, не поверх встреч и не вне рабочих часов. Не обещает больше, чем
 * вмещает день: что не влезло — честно в `unplaced` с подсчётом часов.
 */
export function planDay(input: PlanDayInput): PlanDayResult {
  const brk = (input.breakMin ?? 10) * MIN;
  const [y, m, d] = input.date.split('-').map(Number);
  const s = input.work.workStart.split(':').map(Number);
  const e = input.work.workEnd.split(':').map(Number);
  const dayStart = zonedToUtc(y, m, d, s[0] || 0, s[1] || 0, input.timeZone);
  const dayEnd = zonedToUtc(y, m, d, e[0] || 0, e[1] || 0, input.timeZone);
  const step = 5 * MIN;
  const from = Math.max(dayStart, Math.ceil((input.now + MIN) / step) * step);
  const windows = dayEnd > from ? [{ start: from, end: dayEnd }] : [];
  let free = freeSlots(windows, input.busy).map((f) => ({ ...f }));
  const freeMin = Math.round(free.reduce((n, f) => n + (f.end - f.start), 0) / MIN);
  const needMin = input.items.reduce((n, i) => n + Math.max(5, Math.round(i.minutes)), 0);
  const plan: PlanDayResult['plan'] = [];
  const unplaced: string[] = [];
  for (const it of input.items) {
    const len = Math.max(5, Math.round(it.minutes)) * MIN;
    const slot = free.find((f) => f.end - f.start >= len);
    if (!slot) { unplaced.push(it.id); continue; }
    const start = slot.start;
    plan.push({ id: it.id, startsAt: new Date(start).toISOString(), endsAt: new Date(start + len).toISOString() });
    // остаток окна — после перерыва; окна короче пяти минут не держим
    slot.start = Math.ceil((start + len + brk) / step) * step;
    free = free.filter((f) => f.end - f.start >= 5 * MIN);
  }
  const h = (n: number) => (n % 60 ? `${Math.floor(n / 60)} ч ${n % 60} мин` : `${n / 60} ч`).replace(/^0 ч /, '');
  return {
    plan, unplaced, needMin, freeMin,
    message: unplaced.length ? `На задачи нужно ${h(needMin)}, свободно ${h(freeMin)}. Выберите, что оставить на сегодня.` : null,
  };
}

export interface CommonTimeInput {
  now: number;
  minutes: number;
  /** Занятость каждого участника — только интервалы, без названий (п. 15). */
  required: Record<string, Interval[]>;
  optional: Record<string, Interval[]>;
  work: WorkHours;
  timeZone: string;
  days?: number;
  limit?: number;
}

export interface CommonOption { startsAt: string; endsAt: string; busyOptional: string[]; note: string }

/**
 * Общее время для нескольких людей (#4787, п. 15): окна, где свободны все обязательные
 * участники; лучше — где свободны и необязательные. Чужих подробностей не нужно:
 * на вход — только «занят с … по …».
 */
export function commonTime(input: CommonTimeInput): CommonOption[] {
  const dur = input.minutes * MIN;
  const step = 30 * MIN;
  const days = input.days ?? 10;
  const startFrom = Math.ceil((input.now + 30 * MIN) / step) * step;
  const windows = workWindows(input.now, days, input.work, input.timeZone)
    .map((w) => ({ start: Math.max(w.start, startFrom), end: w.end })).filter((w) => w.end > w.start);
  const busyAt = (list: Interval[], s: number, e: number) => list.some((b) => b.start < e && b.end > s);
  const cand: { s: number; missed: string[] }[] = [];
  for (const w of windows) {
    for (let s = Math.ceil(w.start / step) * step; s + dur <= w.end; s += step) {
      if (Object.values(input.required).some((l) => busyAt(l, s, s + dur))) continue;
      const missed = Object.entries(input.optional).filter(([, l]) => busyAt(l, s, s + dur)).map(([id]) => id);
      cand.push({ s, missed });
    }
  }
  // сначала — где свободны все; по одному варианту на день, чтобы был выбор
  cand.sort((a, b) => a.missed.length - b.missed.length || a.s - b.s);
  const out: CommonOption[] = [];
  const usedDays = new Set<string>();
  for (const pass of [0, 1]) {
    for (const c of cand) {
      if (out.length >= (input.limit ?? 5)) break;
      const day = zonedParts(c.s, input.timeZone).date;
      if ((pass === 0 && usedDays.has(day)) || out.some((o) => Date.parse(o.startsAt) === c.s)) continue;
      usedDays.add(day);
      const n = c.missed.length;
      out.push({
        startsAt: new Date(c.s).toISOString(), endsAt: new Date(c.s + dur).toISOString(), busyOptional: c.missed,
        note: n === 0 ? 'Свободны все участники' : n === 1 ? 'Свободны все, кроме одного необязательного участника' : `Свободны все обязательные, заняты необязательных: ${n}`,
      });
    }
  }
  return out.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}
