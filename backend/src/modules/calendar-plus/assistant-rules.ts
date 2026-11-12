/**
 * Карточка недели и подсказки «Ассистента недели» (#4892, п. 1–2). Чистые правила:
 * на вход — встречи и блоки человека, его рабочие часы и пояс; на выход — цифры
 * и кандидаты в подсказки. Новое время для переноса подбирает сервис (ему нужна
 * занятость других людей), здесь только то, что видно по своему расписанию.
 */
import { freeSlots, Interval, workWindows, WorkHours, zonedParts } from '../calendar/find-time';

const MIN = 60_000;

export interface Meeting {
  id: string;
  title: string;
  start: number;
  end: number;
  /** Я организатор — встречу можно переносить и укорачивать. */
  mine: boolean;
  participants: number;
  /** Есть повестка: описание или собранная повестка. */
  hasAgenda: boolean;
  external?: boolean;
}
export interface Block { id: string; kind: 'task' | 'focus'; start: number; end: number }
export interface OpenTask { id: string; title: string; deadline: number; estimateMin: number | null; planned: boolean }

export interface WeekInput {
  now: number;
  from: number;
  to: number;
  timeZone: string;
  work: WorkHours;
  lunch?: { start: string; end: string } | null;
  meetings: Meeting[];
  blocks: Block[];
  tasks: OpenTask[];
}

export interface Insight {
  meetingMin: number;
  workMin: number;
  /** Пары пересекающихся встреч. */
  overlaps: { a: Meeting; b: Meeting }[];
  /** Цепочки из трёх и больше встреч без перерыва. */
  backToBack: Meeting[][];
  /** Свободные окна от 2 часов в рабочее время. */
  focusWindows: Interval[];
  /** Дни, где встреч больше 5 часов: дата → минуты. */
  heavyDays: { date: string; minutes: number; meetings: Meeting[] }[];
}

const dayKey = (ms: number, tz: string) => zonedParts(ms, tz).date;

function lunchSpans(input: WeekInput): Interval[] {
  if (!input.lunch) return [];
  const days = Math.ceil((input.to - input.from) / 86_400_000) + 1;
  return workWindows(input.from, days, { ...input.work, workStart: input.lunch.start, workEnd: input.lunch.end }, input.timeZone);
}

export function weekInsight(input: WeekInput): Insight {
  const days = Math.ceil((input.to - input.from) / 86_400_000);
  const windows = workWindows(input.from, days, input.work, input.timeZone).filter((w) => w.end > input.from && w.start < input.to);
  const workMin = Math.round(windows.reduce((n, w) => n + (w.end - w.start), 0) / MIN);
  const ms = input.meetings.filter((m) => m.end > input.from && m.start < input.to).sort((a, b) => a.start - b.start);
  // часы встреч — объединением, чтобы накладка не считалась дважды
  let meetingMs = 0;
  let curS = -1; let curE = -1;
  for (const m of ms) {
    if (m.start > curE) { if (curE > curS) meetingMs += curE - curS; curS = m.start; curE = m.end; } else curE = Math.max(curE, m.end);
  }
  if (curE > curS) meetingMs += curE - curS;

  const overlaps: Insight['overlaps'] = [];
  for (let i = 0; i < ms.length; i++) {
    for (let j = i + 1; j < ms.length && ms[j].start < ms[i].end; j++) {
      if (ms[j].start < ms[i].end && ms[j].end > ms[i].start) overlaps.push({ a: ms[i], b: ms[j] });
    }
  }

  const backToBack: Meeting[][] = [];
  let chain: Meeting[] = [];
  for (const m of ms) {
    const last = chain[chain.length - 1];
    if (last && m.start - last.end < 5 * MIN && m.start >= last.start && dayKey(m.start, input.timeZone) === dayKey(last.start, input.timeZone)) chain.push(m);
    else { if (chain.length >= 3) backToBack.push(chain); chain = [m]; }
  }
  if (chain.length >= 3) backToBack.push(chain);

  const busy: Interval[] = [
    ...ms.map((m) => ({ start: m.start, end: m.end })),
    ...input.blocks.map((b) => ({ start: b.start, end: b.end })),
    ...lunchSpans(input),
  ];
  const future = windows.map((w) => ({ start: Math.max(w.start, input.now), end: w.end })).filter((w) => w.end > w.start);
  const focusWindows = freeSlots(future, busy).filter((f) => f.end - f.start >= 120 * MIN);

  const perDay = new Map<string, Meeting[]>();
  for (const m of ms) { const k = dayKey(m.start, input.timeZone); perDay.set(k, [...(perDay.get(k) ?? []), m]); }
  const heavyDays = [...perDay.entries()].map(([date, list]) => ({
    date, meetings: list, minutes: Math.round(list.reduce((n, m) => n + (m.end - m.start), 0) / MIN),
  })).filter((d) => d.minutes > 5 * 60);

  return { meetingMin: Math.round(meetingMs / MIN), workMin, overlaps, backToBack, focusWindows, heavyDays };
}

export type SuggestionKind = 'overlap' | 'heavy_day' | 'buffers' | 'focus_window' | 'agenda';

export interface Candidate {
  kind: SuggestionKind;
  key: string;
  /** Чем меньше, тем важнее. */
  weight: number;
  meeting?: Meeting;
  other?: Meeting;
  chain?: Meeting[];
  window?: Interval;
  task?: OpenTask;
  day?: string;
  dayMeetings?: number;
}

/** Кандидаты в подсказки, по важности. Окно для фокуса — первое подходящее до срока. */
export function candidates(input: WeekInput, insight: Insight): Candidate[] {
  const out: Candidate[] = [];
  const upcoming = (m: Meeting) => m.start > input.now;
  for (const o of insight.overlaps) {
    if (!upcoming(o.a) && !upcoming(o.b)) continue;
    // переносим ту, что моя; обе мои — позднюю; ни одной — подсказка «отказаться» от чужой
    const movable = [o.b, o.a].find((m) => m.mine && !m.external && upcoming(m)) ?? null;
    out.push({ kind: 'overlap', key: `overlap:${o.a.id}:${o.b.id}`, weight: 1, meeting: movable ?? o.b, other: movable === o.a ? o.b : o.a });
  }
  for (const d of insight.heavyDays) {
    const movable = d.meetings.filter((m) => m.mine && upcoming(m) && !m.external).sort((a, b) => a.participants - b.participants)[0];
    if (movable) out.push({ kind: 'heavy_day', key: `heavy:${d.date}`, weight: 2, meeting: movable, day: d.date, dayMeetings: d.meetings.length });
  }
  for (const c of insight.backToBack) {
    if (!c.some(upcoming)) continue;
    // буфер — укорачиваем свои встречи цепочки, кроме последней
    if (!c.slice(0, -1).some((m) => m.mine && !m.external)) continue;
    const day = dayKey(c[0].start, input.timeZone);
    const all = input.meetings.filter((m) => dayKey(m.start, input.timeZone) === day).length;
    out.push({ kind: 'buffers', key: `buffers:${c.map((m) => m.id).join('-')}`, weight: 3, chain: c, day, dayMeetings: all });
  }
  const tasks = input.tasks.filter((t) => !t.planned && t.deadline > input.now && t.deadline <= input.to + 86_400_000)
    .sort((a, b) => a.deadline - b.deadline);
  for (const t of tasks) {
    const need = Math.max(60, Math.min(240, t.estimateMin ?? 120)) * MIN;
    const w = insight.focusWindows.find((f) => f.end - f.start >= need && f.start + need <= t.deadline);
    if (!w) continue;
    out.push({ kind: 'focus_window', key: `focus:${t.id}`, weight: 4, task: t, window: { start: w.start, end: Math.min(w.end, w.start + Math.max(need, 120 * MIN)) } });
    break;
  }
  const noAgenda = input.meetings.filter((m) => m.mine && !m.external && !m.hasAgenda && m.participants >= 2 && upcoming(m))
    .sort((a, b) => a.start - b.start)[0];
  if (noAgenda) out.push({ kind: 'agenda', key: `agenda:${noAgenda.id}`, weight: 5, meeting: noAgenda });
  return out.sort((a, b) => a.weight - b.weight);
}

/** Буферы: свои встречи цепочки, кроме последней, заканчиваются на 10 минут раньше. */
export function bufferChanges(chain: Meeting[], minutes = 10): { id: string; title: string; start: number; end: number; newEnd: number }[] {
  return chain.slice(0, -1).filter((m) => m.mine && !m.external && m.end - m.start > minutes * MIN * 2)
    .map((m) => ({ id: m.id, title: m.title, start: m.start, end: m.end, newEnd: m.end - minutes * MIN }));
}
