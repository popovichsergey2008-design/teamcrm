/**
 * Раскладка календаря: какие дни показываем и куда на сетке ложится событие.
 *
 * Вынесено отдельно от экрана, потому что это ровно то место, где календари ошибаются
 * молча: событие, переходящее через полночь, «весь день», неделя на стыке месяцев,
 * два события в одно время. Ошибку здесь человек видит как «встреча исчезла» — и не
 * может понять, потерял её календарь или он сам.
 *
 * Неделя начинается с понедельника: у нас рабочая неделя, а не американская.
 */

export interface GridEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  allDay?: boolean;
}

/** Кусок события в пределах ОДНОГО дня: доли суток сверху и по высоте. */
export interface DaySegment<T extends GridEvent = GridEvent> {
  event: T;
  dayIndex: number;
  /** 0…1 от начала суток */
  top: number;
  /** 0…1, минимум — чтобы пятиминутная встреча не превратилась в невидимую полоску */
  height: number;
  /** событие началось раньше этого дня */
  continuesFrom: boolean;
  /** событие продолжается после этого дня */
  continuesTo: boolean;
  /** колонка при наложении и сколько всего колонок */
  column: number;
  columns: number;
}

const DAY_MS = 86_400_000;
const MIN_HEIGHT = 0.02; // ~30 минут суток

export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Понедельник недели, в которую попадает дата. */
export function startOfWeek(d: Date): Date {
  const x = startOfDay(d);
  const shift = (x.getDay() + 6) % 7; // 0=пн … 6=вс
  return addDays(x, -shift);
}

/** Дни, которые показывает вид. Месяц всегда отдаёт целые недели — сетка обязана быть прямоугольной. */
export function daysOf(view: 'day' | 'week' | 'month' | 'list', anchor: Date): Date[] {
  if (view === 'day') return [startOfDay(anchor)];
  if (view === 'week') return Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor), i));
  if (view === 'month') {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    const from = startOfWeek(first);
    const to = addDays(startOfWeek(last), 6);
    const out: Date[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
    return out;
  }
  // список: две недели вперёд от сегодняшнего дня
  return Array.from({ length: 14 }, (_, i) => addDays(startOfDay(anchor), i));
}

/**
 * Событие → куски по дням.
 *
 * Событие, начавшееся вчера в 23:00 и закончившееся сегодня в 01:00, обязано быть видно
 * в обоих днях, а не исчезнуть из вчерашнего или растянуться на сутки.
 */
export function splitByDay<T extends GridEvent>(event: T, days: Date[]): DaySegment<T>[] {
  const start = new Date(event.startsAt);
  const end = new Date(event.endsAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];

  const out: DaySegment<T>[] = [];
  for (const [dayIndex, day] of days.entries()) {
    const dayStart = startOfDay(day);
    const dayEnd = addDays(dayStart, 1);
    if (end <= dayStart || start >= dayEnd) continue;

    const from = Math.max(start.getTime(), dayStart.getTime());
    const to = Math.min(end.getTime(), dayEnd.getTime());
    const top = (from - dayStart.getTime()) / DAY_MS;
    const height = Math.max((to - from) / DAY_MS, MIN_HEIGHT);
    out.push({
      event,
      dayIndex,
      top,
      // событие не должно вылезать за нижний край суток
      height: Math.min(height, 1 - top),
      continuesFrom: start < dayStart,
      continuesTo: end > dayEnd,
      column: 0,
      columns: 1,
    });
  }
  return out;
}

/**
 * Наложения внутри одного дня → колонки.
 *
 * Два события на одно время должны стоять рядом, а не друг на друге: закрытое сверху
 * событие для человека не существует. Алгоритм простой и предсказуемый: события по
 * времени начала, каждое занимает первую свободную колонку; группа считается закрытой,
 * когда началось событие позже конца всех предыдущих.
 */
export function layoutDay<T extends GridEvent>(segments: DaySegment<T>[]): DaySegment<T>[] {
  const sorted = [...segments].sort((a, b) => a.top - b.top || b.height - a.height);
  let group: DaySegment<T>[] = [];
  let groupEnd = 0;

  const closeGroup = () => {
    const columns = group.reduce((max, s) => Math.max(max, s.column + 1), 1);
    for (const s of group) s.columns = columns;
    group = [];
    groupEnd = 0;
  };

  for (const seg of sorted) {
    if (group.length && seg.top >= groupEnd - 1e-9) closeGroup();
    const busy = new Set(group.filter((s) => s.top + s.height > seg.top + 1e-9).map((s) => s.column));
    let col = 0;
    while (busy.has(col)) col++;
    seg.column = col;
    group.push(seg);
    groupEnd = Math.max(groupEnd, seg.top + seg.height);
  }
  closeGroup();
  return sorted;
}

/** Выходной по настройке организации: день недели или явная праздничная дата. */
export function isDayOff(day: Date, work: { weekendDays: number[]; holidays: string[] }): boolean {
  if (work.weekendDays?.includes(day.getDay())) return true;
  const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  return (work.holidays ?? []).includes(iso);
}

/** «09:00» → доля суток. Нужна, чтобы подсветить рабочие часы на сетке. */
export function timeToFraction(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return Math.min(Math.max((h * 60 + m) / 1440, 0), 1);
}

/** Заголовок периода — то, что человек читает вместо дат: «25 — 31 августа». */
export function rangeTitle(view: 'day' | 'week' | 'month' | 'list', days: Date[]): string {
  if (!days.length) return '';
  const first = days[0];
  const last = days[days.length - 1];
  const month = (d: Date) => d.toLocaleDateString('ru-RU', { month: 'long' });
  if (view === 'day') return first.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  if (view === 'month') {
    // в месячной сетке крайние дни принадлежат соседям — подписываем по середине
    const mid = days[Math.floor(days.length / 2)];
    return `${month(mid)} ${mid.getFullYear()}`;
  }
  const sameMonth = first.getMonth() === last.getMonth();
  return sameMonth
    ? `${first.getDate()} — ${last.getDate()} ${month(first)}`
    : `${first.getDate()} ${month(first)} — ${last.getDate()} ${month(last)}`;
}
