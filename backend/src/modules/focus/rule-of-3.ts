import { localParts } from '../assistant/ping-rules';

/**
 * «Правило трёх» (ТЗ-16, п. 13–28): из всего, что человеку предстоит, — до трёх
 * главных действий на день, с объяснением «почему».
 *
 * Считает сервер и только правилами: срок, кто ждёт человека, договорённость на
 * созвоне, приоритет. Модель здесь не участвует — у большинства организаций нет ключа
 * ИИ, а объяснение, собранное из тех же чисел, всегда правда и ничего не стоит.
 *
 * Формула `rule_of_3_v1` (п. 16):
 *   0.35 · срок + 0.30 · «разблокирует» + 0.25 · созвон + 0.10 · приоритет − штраф
 * Любое изменение весов или шкал — новая версия (п. 103): по версии в плане видно,
 * по какой формуле он собран.
 */
export const SCORE_VERSION = 'rule_of_3_v1';

export type CandidateKind = 'task' | 'review' | 'approval';

export interface Candidate {
  kind: CandidateKind;
  /** ключ для сравнения: `task:15`, `review:15`, `approval:4` */
  key: string;
  taskId: string | null;
  approvalId: string | null;
  title: string;
  projectName: string | null;
  deadlineAt: string | Date | null;
  priority: string | null;
  /** задача отмечена заблокированной — сделать её сейчас нельзя */
  isBlocked: boolean;
  /**
   * Сколько людей ждёт этого действия. Связей «блокирует» в системе нет (решение
   * заказчика — их не заводим), поэтому «разблокирует» — это то, что видно и так:
   * сданная мне на проверку работа (ждёт исполнитель) и согласование (ждёт автор).
   */
  waiting: number;
  /** кто ждёт — для объяснения («ждёт Глеб») */
  waitingName: string | null;
  /** сила договорённости на созвоне за сутки: 100 — поручили на созвоне, 0 — не было */
  meeting: number;
  meetingTitle: string | null;
  /** человек сам поставил «В сегодня» (tasks.focus_date) — закрепление */
  pinned: boolean;
  estimateHours: number | null;
}

export interface Scored extends Candidate {
  score: number;
  deadlineScore: number;
  unlockScore: number;
  meetingScore: number;
  baseScore: number;
  penalty: number;
  reasons: string[];
  /** достойно места в тройке само по себе, без добивания «до трёх» */
  worthy: boolean;
}

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** Разница в днях между местными датами «2026-10-07». */
function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

const hhmm = (p: { hour: number; minute: number }) => `${p.hour}:${String(p.minute).padStart(2, '0')}`;

/**
 * Срок (п. 17): просрочена 100 · сегодня 95 · завтра 75 · 2–3 дня 55 · неделя 40 ·
 * позже 20 · без срока 15. Время внутри дня тоже важно: «сегодня в 11:00» срочнее
 * «сегодня в 18:00» — добавляем до пяти пунктов тому, что ближе.
 */
export function deadlineScore(deadline: string | Date | null, now: Date, tz: string): { score: number; reason: string | null } {
  if (!deadline) return { score: 15, reason: null };
  const at = new Date(deadline);
  const today = localParts(now, tz);
  const due = localParts(at, tz);
  const days = dayDiff(due.date, today.date);
  if (at.getTime() < now.getTime()) {
    const late = Math.max(0, dayDiff(today.date, due.date));
    return { score: 100, reason: late >= 1 ? `просрочена на ${late} ${plural(late, 'день', 'дня', 'дней')}` : `срок был сегодня в ${hhmm(due)}` };
  }
  if (days <= 0) {
    const hoursLeft = (at.getTime() - now.getTime()) / 3_600_000;
    const bump = Math.max(0, Math.min(5, 5 - hoursLeft / 2));
    return { score: 95 + Math.round(bump * 10) / 10, reason: `срок сегодня в ${hhmm(due)}` };
  }
  if (days === 1) return { score: 75, reason: `срок завтра в ${hhmm(due)}` };
  const [, m, d] = due.date.split('-').map(Number);
  const when = `${d} ${MONTHS[m - 1]}`;
  if (days <= 3) return { score: 55, reason: `срок ${when}` };
  if (days <= 7) return { score: 40, reason: null };
  return { score: 20, reason: null };
}

/** Приоритет (п. 21). Не выставлен — 40: середина, а не «низкий». */
export function baseScore(priority: string | null): number {
  switch (priority) {
    case 'urgent': return 100;
    case 'high': return 80;
    case 'normal': return 50;
    case 'low': return 25;
    default: return 40;
  }
}

/** «Разблокирует» (п. 18): 0 → 0 · 1 → 30 · 2–3 → 60 · больше → 90. */
export function unlockScore(waiting: number): number {
  if (waiting <= 0) return 0;
  if (waiting === 1) return 30;
  if (waiting <= 3) return 60;
  return 90;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

export function scoreCandidate(c: Candidate, now: Date, tz: string): Scored {
  const d = deadlineScore(c.deadlineAt, now, tz);
  const u = unlockScore(c.waiting);
  const m = Math.max(0, Math.min(100, c.meeting));
  const b = baseScore(c.priority);
  // Заблокированное сделать нельзя — пусть срок его и не тянет в главные (п. 19).
  const penalty = c.isBlocked ? 50 : 0;
  const raw = 0.35 * d.score + 0.30 * u + 0.25 * m + 0.10 * b - penalty;
  const score = Math.round(Math.max(0, Math.min(100, raw)) * 10) / 10;

  const reasons: string[] = [];
  if (c.pinned) reasons.push('вы сами поставили её на сегодня');
  if (d.reason) reasons.push(d.reason);
  if (c.kind === 'review') reasons.push(c.waitingName ? `${c.waitingName} ждёт, когда вы примете работу` : 'работа сдана — ждёт вашей проверки');
  else if (c.kind === 'approval') reasons.push(c.waitingName ? `${c.waitingName} ждёт вашего согласования` : 'ждёт вашего согласования');
  else if (c.waiting > 0) reasons.push(`ждут ${c.waiting} ${plural(c.waiting, 'человек', 'человека', 'человек')}`);
  if (m >= 85) reasons.push(c.meetingTitle ? `поручили на созвоне «${c.meetingTitle}»` : 'поручили на созвоне');
  else if (m > 0) reasons.push(c.meetingTitle ? `обсуждали на созвоне «${c.meetingTitle}»` : 'обсуждали на созвоне');
  if (c.priority === 'urgent') reasons.push('приоритет — срочно');
  else if (c.priority === 'high') reasons.push('приоритет — высокий');
  if (c.isBlocked) reasons.push('отмечена заблокированной — поэтому ниже');

  // Достойное место в тройке — то, что само говорит «сегодня» (п. 14: не добиваем
  // экран до трёх искусственно): срок до трёх дней, срочность, ждут люди, созвон, закрепление.
  const worthy = !c.isBlocked && (c.pinned || d.score >= 55 || c.priority === 'urgent' || c.priority === 'high' || u > 0 || m > 0);
  return { ...c, score, deadlineScore: d.score, unlockScore: u, meetingScore: m, baseScore: b, penalty, reasons, worthy };
}

/**
 * Выбрать тройку.
 *
 * 1. Закреплённое человеком идёт первым — его не вытесняет никакой пересчёт (п. 23).
 * 2. Дальше — по очкам, только «достойное».
 * 3. Разнообразие (п. 27): не больше двух проверок/согласований, если есть своя
 *    достойная задача — иначе утро уходит на чужое, а своё главное ждёт.
 * 4. Ёмкость дня (п. 28): если оценки известны и три задачи не влезают в свободные
 *    часы — лишнее не берём (закреплённое остаётся всегда).
 */
export function pickTop3(scored: Scored[], opts: { freeHours?: number | null } = {}): Scored[] {
  const byScore = [...scored].sort((a, b) => b.score - a.score || keyOrder(a, b));
  const pins = byScore.filter((c) => c.pinned).slice(0, 3);
  const rest = byScore.filter((c) => !c.pinned && c.worthy);
  const hasOwn = rest.some((c) => c.kind === 'task');
  const out: Scored[] = [...pins];
  let hours = pins.reduce((s, c) => s + (c.estimateHours ?? 0), 0);
  for (const c of rest) {
    if (out.length >= 3) break;
    const others = out.filter((x) => x.kind !== 'task').length;
    if (c.kind !== 'task' && others >= 2 && hasOwn) continue;
    if (opts.freeHours != null && c.estimateHours && hours + c.estimateHours > opts.freeHours && out.length > 0) continue;
    out.push(c);
    hours += c.estimateHours ?? 0;
  }
  // Главная миссия — самое весомое из выбранного, закрепления не сбивают порядок по очкам.
  return out.sort((a, b) => b.score - a.score || keyOrder(a, b));
}

/** Равные очки — сначала своя работа, потом по ключу: порядок не должен прыгать. */
function keyOrder(a: Scored, b: Scored): number {
  const kind = (k: CandidateKind) => (k === 'task' ? 0 : k === 'review' ? 1 : 2);
  return kind(a.kind) - kind(b.kind) || a.key.localeCompare(b.key);
}
