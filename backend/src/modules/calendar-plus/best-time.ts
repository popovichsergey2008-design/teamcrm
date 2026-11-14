/**
 * «Найти время» с объяснением (#4892, п. 4): три лучших слота для нескольких людей.
 *
 * Чистая функция: на вход — рабочие часы, обед, пояс и занятость каждого (только
 * интервалы и вид — «встреча», «фокус», «нет на месте», без названий чужих встреч),
 * на выход — слоты с причинами. Правила подбора — дословно из ТЗ:
 *  - только в рабочих часах ВСЕХ участников, каждый — в своём поясе;
 *  - обед и защищённый фокус не предлагаются;
 *  - последние 30 минут рабочего дня — только если других вариантов нет;
 *  - не ставить кому-то третью встречу подряд;
 *  - лучше рядом с уже существующими встречами, чтобы не дробить день;
 *  - необязательный участник слот не блокирует, но помечается «Алина занята».
 */
import { zonedParts, zonedToUtc } from '../calendar/find-time';

export interface Span { start: number; end: number }
export interface BusySpan extends Span {
  kind: 'meeting' | 'focus' | 'away';
  /** Название — только для СВОИХ встреч того, кто ищет: «сразу после планёрки». */
  title?: string | null;
}

export interface Person {
  id: string;
  name: string;
  timeZone: string;
  workStart: string; // 'HH:MM' в его поясе
  workEnd: string;
  lunchStart?: string | null;
  lunchEnd?: string | null;
  weekendDays: number[];
  holidays: string[];
  busy: BusySpan[];
  optional?: boolean;
  /** Тот, кто ищет: его встречи можно называть по имени. */
  me?: boolean;
}

export interface BestTimeInput {
  now: number;
  minutes: number;
  people: Person[];
  /** Пояс того, кто смотрит: «сегодня», «завтра» и полосы занятости — в нём. */
  viewerTimeZone: string;
  days?: number;
  limit?: number;
  /** Не раньше этого момента (например, «завтра» из фразы в чате). */
  notBefore?: number | null;
  /** Не позже (конец дня, названного во фразе). */
  notAfter?: number | null;
  stepMin?: number;
}

export interface BestSlot {
  startsAt: string;
  endsAt: string;
  best: boolean;
  score: number;
  /** «все свободны · не в фокусе · у всех перерыв до и после» */
  reasons: string[];
  /** Необязательные, кто занят: «Алина занята». */
  busyOptional: string[];
}

export interface BestTimeResult { slots: BestSlot[]; message: string | null }

const MIN = 60_000;
const DAY = 86_400_000;

const hm = (s: string | null | undefined) => {
  const [h, m] = String(s ?? '').split(':').map(Number);
  return { h: Number.isFinite(h) ? h : 0, m: Number.isFinite(m) ? m : 0 };
};

/** Рабочее окно человека в день, где лежит момент `at` (по его поясу); выходной — null. */
export function workWindowAt(p: Person, at: number): (Span & { lunch: Span | null }) | null {
  const d = zonedParts(at, p.timeZone);
  if (p.weekendDays.includes(d.weekday) || p.holidays.includes(d.date)) return null;
  const s = hm(p.workStart);
  const e = hm(p.workEnd);
  const start = zonedToUtc(d.y, d.m, d.d, s.h, s.m, p.timeZone);
  const end = zonedToUtc(d.y, d.m, d.d, e.h, e.m, p.timeZone);
  if (end <= start) return null;
  let lunch: Span | null = null;
  if (p.lunchStart && p.lunchEnd) {
    const ls = hm(p.lunchStart);
    const le = hm(p.lunchEnd);
    const a = zonedToUtc(d.y, d.m, d.d, ls.h, ls.m, p.timeZone);
    const b = zonedToUtc(d.y, d.m, d.d, le.h, le.m, p.timeZone);
    if (b > a) lunch = { start: a, end: b };
  }
  return { start, end, lunch };
}

const overlaps = (a: Span, b: Span) => a.start < b.end && a.end > b.start;

/** Сколько встреч подряд получится у человека, если поставить слот (зазор до 10 минут — «подряд»). */
export function chainWith(busy: BusySpan[], slot: Span, gapMin = 10): number {
  const meetings = busy.filter((b) => b.kind === 'meeting').sort((a, b) => a.start - b.start);
  let n = 1;
  let edge = slot.start;
  for (let i = meetings.length - 1; i >= 0; i--) {
    const m = meetings[i];
    if (m.end <= edge && edge - m.end <= gapMin * MIN) { n++; edge = m.start; }
  }
  edge = slot.end;
  for (const m of meetings) {
    if (m.start >= edge && m.start - edge <= gapMin * MIN) { n++; edge = m.end; }
  }
  return n;
}

/** «Мск», «Екб, +2» — пояс у имени участника относительно того, кто смотрит. */
const CITY: Record<string, string> = {
  'Europe/Moscow': 'Мск', 'Europe/Kaliningrad': 'Клг', 'Europe/Samara': 'Смр', 'Europe/Volgograd': 'Влг',
  'Asia/Yekaterinburg': 'Екб', 'Asia/Omsk': 'Омск', 'Asia/Novosibirsk': 'Нск', 'Asia/Krasnoyarsk': 'Крс',
  'Asia/Irkutsk': 'Ирк', 'Asia/Yakutsk': 'Якт', 'Asia/Vladivostok': 'Влд', 'Asia/Magadan': 'Мгд',
  'Asia/Kamchatka': 'Кам', 'Europe/Minsk': 'Минск', 'Asia/Almaty': 'Алматы', 'Asia/Tashkent': 'Ташкент',
  'Europe/Kiev': 'Киев', 'Europe/Kyiv': 'Киев', 'Asia/Tbilisi': 'Тбилиси', 'Asia/Yerevan': 'Ереван',
  'Asia/Dubai': 'Дубай', 'Europe/Istanbul': 'Стамбул', 'Europe/Berlin': 'Берлин', 'Europe/London': 'Лондон',
};

export function offsetMinutes(timeZone: string, at: number): number {
  const p = zonedParts(at, timeZone);
  return Math.round((Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm) - Math.floor(at / MIN) * MIN) / MIN);
}

export function zoneLabel(timeZone: string, viewerTimeZone: string, at: number): string | null {
  if (timeZone === viewerTimeZone) return null;
  const diff = Math.round((offsetMinutes(timeZone, at) - offsetMinutes(viewerTimeZone, at)) / 60 * 10) / 10;
  const city = CITY[timeZone] ?? timeZone.split('/').pop()!.replace(/_/g, ' ');
  if (!diff) return city;
  return `${city}, ${diff > 0 ? '+' : ''}${String(diff).replace('.', ',')}`;
}

/** Подбор. Ничего не создаёт — только варианты с причинами. */
export function bestTime(input: BestTimeInput): BestTimeResult {
  const dur = Math.max(5, Math.min(480, Math.round(input.minutes))) * MIN;
  const step = (input.stepMin ?? 30) * MIN;
  const limit = input.limit ?? 3;
  const days = input.days ?? 10;
  const required = input.people.filter((p) => !p.optional);
  const optional = input.people.filter((p) => p.optional);
  if (!required.length) return { slots: [], message: 'Добавьте участников' };
  const from = Math.max(Math.ceil((input.now + 15 * MIN) / step) * step, input.notBefore ?? 0);
  const until = Math.min(input.now + days * DAY, input.notAfter ?? Infinity);

  interface Cand { s: number; score: number; reasons: string[]; busyOptional: string[]; lastHalf: boolean }
  const cands: Cand[] = [];
  for (let s = from; s + dur <= until; s += step) {
    const slot = { start: s, end: s + dur };
    let ok = true;
    let lastHalf = false;
    let anyFocusDay = false;
    let breaksAll = true;
    let maxChain = 1;
    let chainName = '';
    let adjacentMine: string | null = null;
    let adjacentAny = false;
    for (const p of required) {
      const w = workWindowAt(p, s);
      if (!w || s < w.start || s + dur > w.end) { ok = false; break; }
      if (w.lunch && overlaps(slot, w.lunch)) { ok = false; break; }
      if (p.busy.some((b) => overlaps(slot, b))) { ok = false; break; }
      if (w.end - (s + dur) < 30 * MIN && s + dur > w.end - 30 * MIN) lastHalf = true;
      if (p.busy.some((b) => b.kind === 'focus' && zonedParts(b.start, p.timeZone).date === zonedParts(s, p.timeZone).date)) anyFocusDay = true;
      const near = p.busy.filter((b) => b.kind === 'meeting' && (Math.abs(b.end - s) < 10 * MIN || Math.abs(slot.end - b.start) < 10 * MIN));
      if (near.length) breaksAll = false;
      const closeBy = p.busy.find((b) => b.kind === 'meeting' && ((s - b.end >= 0 && s - b.end <= 30 * MIN) || (b.start - slot.end >= 0 && b.start - slot.end <= 30 * MIN)));
      if (closeBy) {
        adjacentAny = true;
        if (p.me && closeBy.title && !adjacentMine) adjacentMine = `${closeBy.end <= s ? 'сразу после' : 'прямо перед'} «${closeBy.title}»`;
      }
      const chain = chainWith(p.busy, slot);
      if (chain > maxChain) { maxChain = chain; chainName = p.me ? 'у вас' : `у ${p.name.split(' ')[0]}`; }
    }
    if (!ok) continue;
    const busyOptional = optional.filter((p) => {
      const w = workWindowAt(p, s);
      return !w || s < w.start || s + dur > w.end || (w.lunch && overlaps(slot, w.lunch)) || p.busy.some((b) => overlaps(slot, b));
    }).map((p) => p.name.split(' ')[0]);
    const reasons: string[] = [];
    let score = 100;
    if (busyOptional.length) { score -= 15 * busyOptional.length; reasons.push(`свободны все обязательные · ${busyOptional.join(', ')} ${busyOptional.length === 1 ? 'занят(а)' : 'заняты'}`); }
    else reasons.push(input.people.length > 1 ? 'все свободны' : 'вы свободны');
    if (anyFocusDay) reasons.push('не в фокусе');
    if (maxChain >= 3) { score -= 40; reasons.push(`${chainName} ${maxChain}-я встреча подряд`); }
    if (breaksAll && input.people.length > 1) { score += 6; reasons.push('у всех перерыв до и после'); }
    else if (breaksAll) { score += 6; reasons.push('с перерывом до и после'); }
    if (adjacentMine) { score += 8; reasons.push(adjacentMine); } else if (adjacentAny) { score += 5; reasons.push('рядом с другими встречами — день не дробится'); }
    if (lastHalf) { score -= 60; reasons.push('в последние 30 минут рабочего дня'); }
    // ближе — чуть лучше: «завтра» обычно удобнее, чем через неделю
    score -= Math.floor((s - input.now) / DAY) * 2;
    cands.push({ s, score, reasons, busyOptional, lastHalf });
  }
  // конец дня — только если других вариантов нет вовсе
  const pool = cands.some((c) => !c.lastHalf) ? cands.filter((c) => !c.lastHalf) : cands;
  pool.sort((a, b) => b.score - a.score || a.s - b.s);
  const out: Cand[] = [];
  const usedDays = new Set<string>();
  const usedTimes = new Set<string>();
  // По одному варианту на день и в разное время суток — чтобы был выбор (#4920, п. 9: три
  // варианта «в 09:00» на разные дни выбором не являются), потом добиваем лучшими.
  for (const pass of [0, 1, 2]) {
    for (const c of pool) {
      if (out.length >= limit) break;
      const p = zonedParts(c.s, input.viewerTimeZone);
      const time = `${p.hh}:${p.mm}`;
      if (out.includes(c) || (pass < 2 && usedDays.has(p.date)) || (pass === 0 && usedTimes.has(time))) continue;
      usedDays.add(p.date);
      usedTimes.add(time);
      out.push(c);
    }
  }
  out.sort((a, b) => b.score - a.score || a.s - b.s);
  const slots = out.map((c, i) => ({
    startsAt: new Date(c.s).toISOString(), endsAt: new Date(c.s + dur).toISOString(),
    best: i === 0, score: c.score, reasons: c.reasons, busyOptional: c.busyOptional,
  }));
  return {
    slots,
    message: slots.length ? null : `В ближайшие ${days} дней нет общего окна на ${Math.round(dur / MIN)} минут в рабочих часах всех участников. Попробуйте короче или отправьте опрос времени.`,
  };
}

/** Полоса занятости дня (#4892, п. 4): встречи, фокус, обед — без названий. */
export function dayBar(p: Person, dayAnchor: number, viewerWindow: Span): { kind: 'meeting' | 'focus' | 'lunch' | 'off'; start: number; end: number }[] {
  const out: { kind: 'meeting' | 'focus' | 'lunch' | 'off'; start: number; end: number }[] = [];
  const w = workWindowAt(p, dayAnchor);
  if (!w) return [{ kind: 'off', start: viewerWindow.start, end: viewerWindow.end }];
  if (w.start > viewerWindow.start) out.push({ kind: 'off', start: viewerWindow.start, end: Math.min(w.start, viewerWindow.end) });
  if (w.end < viewerWindow.end) out.push({ kind: 'off', start: Math.max(w.end, viewerWindow.start), end: viewerWindow.end });
  if (w.lunch) out.push({ kind: 'lunch', start: w.lunch.start, end: w.lunch.end });
  for (const b of p.busy) {
    if (b.end <= viewerWindow.start || b.start >= viewerWindow.end) continue;
    out.push({ kind: b.kind === 'focus' ? 'focus' : 'meeting', start: Math.max(b.start, viewerWindow.start), end: Math.min(b.end, viewerWindow.end) });
  }
  return out.sort((a, b) => a.start - b.start);
}
