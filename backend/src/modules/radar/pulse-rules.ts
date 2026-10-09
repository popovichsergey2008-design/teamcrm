/**
 * «Пульс команды» (ТЗ-19) — все расчёты правилами.
 *
 * Модель не считает ни одной цифры (§7, §53): индекс здоровья, загрузка, скорость и
 * прогноз — арифметика над фактами, у каждой цифры есть «почему». Версии формул
 * хранятся рядом с результатом: поменяем веса — старые прогнозы останутся сравнимыми.
 */

export const HEALTH_VERSION = 'health_v1';
export const FORECAST_VERSION = 'forecast_v1';

export type Priority = 'low' | 'normal' | 'high' | 'urgent';

export interface TaskFact {
  id: string; title: string; projectId: string; projectName: string;
  assigneeId: string | null; assigneeName: string | null; createdBy: string | null;
  priority: Priority; deadlineAt: Date | null; createdAt: Date;
  inReview: boolean; isBlocked: boolean;
  /** Последнее осмысленное движение: статус, чек-лист, комментарий, файл, исполнитель (§22). */
  lastMove: Date;
}

const H = 3_600_000;
const D = 24 * H;
const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

// ── застрявшие задачи (§22–25) ──

/** Сколько часов без движения считается «застряла» — по приоритету (§23). */
export const STUCK_HOURS: Record<Priority, number> = { urgent: 12, high: 24, normal: 72, low: 120 };

export type BottleneckType =
  | 'NO_ASSIGNEE' | 'OVERDUE' | 'WAITING_REVIEW' | 'BLOCKED' | 'ASSIGNEE_OVERLOADED' | 'NO_ACTIVITY';

export type ActionType = 'TASK_NUDGE' | 'TASK_REASSIGN' | 'TASK_RESCHEDULE' | 'TASK_CREATE_MEETING' | 'REVIEW_REMINDER' | 'TASK_FOCUS';

export const BOTTLENECK_TITLE: Record<BottleneckType, string> = {
  NO_ASSIGNEE: 'Нет исполнителя',
  OVERDUE: 'Просрочена',
  WAITING_REVIEW: 'Ждёт проверки',
  BLOCKED: 'Есть блокер',
  ASSIGNEE_OVERLOADED: 'Исполнитель перегружен',
  NO_ACTIVITY: 'Нет движения',
};

/** Что предлагать первым для каждого вида затыка (§25). */
export const ACTIONS_FOR: Record<BottleneckType, ActionType[]> = {
  NO_ASSIGNEE: ['TASK_REASSIGN'],
  OVERDUE: ['TASK_NUDGE', 'TASK_RESCHEDULE', 'TASK_REASSIGN', 'TASK_CREATE_MEETING'],
  WAITING_REVIEW: ['REVIEW_REMINDER', 'TASK_CREATE_MEETING'],
  BLOCKED: ['TASK_CREATE_MEETING', 'TASK_REASSIGN', 'TASK_RESCHEDULE'],
  ASSIGNEE_OVERLOADED: ['TASK_REASSIGN', 'TASK_RESCHEDULE'],
  NO_ACTIVITY: ['TASK_NUDGE', 'TASK_REASSIGN', 'TASK_CREATE_MEETING'],
};

export function hoursIdle(t: TaskFact, now: Date): number {
  return Math.max(0, (now.getTime() - t.lastMove.getTime()) / H);
}

export function isStuck(t: TaskFact, now: Date): boolean {
  return hoursIdle(t, now) >= STUCK_HOURS[t.priority];
}

/**
 * Вид затыка. Порядок — от того, что решает руководитель, к тому, что решает
 * исполнитель: без исполнителя задачу некому делать вовсе, просрочка уже стоит денег,
 * проверка ждёт конкретного человека. Не застрявшая и не просроченная задача — не затык.
 */
export function bottleneckType(t: TaskFact, now: Date, overloaded: Set<string>): BottleneckType | null {
  const stuck = isStuck(t, now);
  if (!t.assigneeId) return now.getTime() - t.createdAt.getTime() > D ? 'NO_ASSIGNEE' : null;
  if (t.deadlineAt && t.deadlineAt.getTime() < now.getTime()) return 'OVERDUE';
  if (t.inReview && stuck) return 'WAITING_REVIEW';
  if (t.isBlocked) return 'BLOCKED';
  if (stuck && overloaded.has(t.assigneeId)) return 'ASSIGNEE_OVERLOADED';
  if (stuck) return 'NO_ACTIVITY';
  return null;
}

const PRIORITY_WEIGHT: Record<Priority, number> = { urgent: 4, high: 3, normal: 1, low: 0 };

/** Насколько срочно смотреть: просрочка в днях весит больше всего, потом приоритет и простой. */
export function bottleneckSeverity(t: TaskFact, type: BottleneckType, now: Date): number {
  const overdueDays = t.deadlineAt ? Math.max(0, (now.getTime() - t.deadlineAt.getTime()) / D) : 0;
  const typeWeight = type === 'NO_ASSIGNEE' ? 3 : type === 'BLOCKED' ? 3 : type === 'OVERDUE' ? 2 : 1;
  return Math.round(overdueDays * 3 + PRIORITY_WEIGHT[t.priority] * 2 + hoursIdle(t, now) / 24 + typeWeight * 2);
}

/** «Что произошло» одной строкой — без оценок, только факты (§21). */
export function bottleneckWhy(t: TaskFact, type: BottleneckType, now: Date): string {
  const idle = hoursIdle(t, now);
  const idleText = idle >= 48 ? `${Math.floor(idle / 24)} дн. без движения` : `${Math.floor(idle)} ч без движения`;
  switch (type) {
    case 'NO_ASSIGNEE': return `Исполнитель не назначен ${Math.floor((now.getTime() - t.createdAt.getTime()) / D)} дн.`;
    case 'OVERDUE': {
      const days = Math.max(1, Math.ceil((now.getTime() - t.deadlineAt!.getTime()) / D));
      return `Срок прошёл ${days} дн. назад · ${idleText}`;
    }
    case 'WAITING_REVIEW': return `Сдана на проверку, ${idleText}`;
    case 'BLOCKED': return `Исполнитель отметил блокер · ${idleText}`;
    case 'ASSIGNEE_OVERLOADED': return `${idleText}, а у исполнителя загрузка выше нормы`;
    default: return idleText;
  }
}

// ── загрузка (§31–33, решение 09.10: очки, 100% = личная норма) ──

export const DEFAULT_NORM_POINTS = 12;

export interface LoadInput {
  tasks: Pick<TaskFact, 'priority' | 'deadlineAt'>[];
  /** Сданное мне на проверку и ждущее меня. */
  reviewsWaiting: number;
  meetingHoursToday: number;
}

export interface LoadBreakdown { points: number; active: number; urgent: number; overdue: number; dueSoon: number; reviews: number; meetingHours: number }

/**
 * Очки нагрузки: каждая открытая задача — 1; срочная или высокая +1; просроченная +1;
 * срок в ближайшие 3 дня +1; проверка чужой работы — 0,5; час встреч сегодня — 1.
 * Подписываем на экране, что это оценка по задачам, а не по часам: оценок времени
 * у задач нет, и проценты в часах были бы выдуманными.
 */
export function loadPoints(i: LoadInput, now: Date): LoadBreakdown {
  let points = 0; let urgent = 0; let overdue = 0; let dueSoon = 0;
  for (const t of i.tasks) {
    points += 1;
    if (t.priority === 'high' || t.priority === 'urgent') { points += 1; urgent += 1; }
    if (t.deadlineAt) {
      const left = t.deadlineAt.getTime() - now.getTime();
      if (left < 0) { points += 1; overdue += 1; } else if (left <= 3 * D) { points += 1; dueSoon += 1; }
    }
  }
  points += i.reviewsWaiting * 0.5 + i.meetingHoursToday;
  return { points: Math.round(points * 10) / 10, active: i.tasks.length, urgent, overdue, dueSoon, reviews: i.reviewsWaiting, meetingHours: i.meetingHoursToday };
}

export function capacityPct(points: number, norm: number | null | undefined): number {
  const n = norm && norm > 0 ? norm : DEFAULT_NORM_POINTS;
  return Math.round((points / n) * 100);
}

export type Band = 'available' | 'normal' | 'high' | 'overloaded';
export function band(pct: number): Band {
  if (pct <= 60) return 'available';
  if (pct <= 85) return 'normal';
  if (pct <= 100) return 'high';
  return 'overloaded';
}

/** Риск задержек человека словами — без «выгорания» (§17). */
export function delayRisk(pct: number, overdue: number): 'низкий' | 'средний' | 'высокий' {
  if (pct > 100 || overdue >= 3) return 'высокий';
  if (pct > 85 || overdue >= 1) return 'средний';
  return 'низкий';
}

// ── индекс здоровья (§13–16) ──

export interface HealthInput {
  closed30: number; created30: number;
  open: number; withDeadline: number; overdue: number; criticalOverdue: number; avgOverdueDays: number;
  stuck: number; reviewStuck: number; noAssignee: number;
  people: { pct: number }[];
  last7: number; prev7: number;
}

export interface HealthComponents { delivery: number; deadlines: number; flow: number; capacity: number; velocity: number }

export function healthComponents(i: HealthInput): HealthComponents {
  // Закрываем ли столько, сколько приходит: 100 — закрыто не меньше, чем заведено за 30 дней.
  // Ничего не заводили — сравнивать не с чем: нейтральные 75, а не ноль (иначе тихий месяц
  // выглядел бы провалом: «закрываем меньше, чем приходит», когда не приходит ничего).
  const delivery = i.created30 === 0
    ? (i.closed30 > 0 ? 100 : 75)
    : clamp(Math.round((100 * i.closed30) / i.created30));
  const overdueRatio = i.withDeadline ? i.overdue / i.withDeadline : 0;
  const deadlines = clamp(Math.round(100 * (1 - overdueRatio) - Math.min(20, i.avgOverdueDays * 2) - Math.min(25, i.criticalOverdue * 5)));
  const stuckRatio = i.open ? i.stuck / i.open : 0;
  const flow = clamp(Math.round(100 - stuckRatio * 150 - Math.min(20, i.reviewStuck * 3)));
  const over = i.people.filter((p) => p.pct > 100).length;
  const high = i.people.filter((p) => p.pct > 85 && p.pct <= 100).length;
  const capacity = clamp(Math.round(100 - over * 15 - high * 5 - Math.min(20, i.noAssignee * 2)));
  // Скорость: тот же темп — 75, вдвое быстрее — 100 (потолок), вдвое медленнее — 50.
  const velocity = i.prev7 === 0
    ? (i.last7 > 0 ? 80 : 50)
    : clamp(Math.round(75 + 50 * (i.last7 / i.prev7 - 1)));
  return { delivery, deadlines, flow, capacity, velocity };
}

export function healthScore(c: HealthComponents): number {
  return Math.round(0.25 * c.delivery + 0.2 * c.deadlines + 0.2 * c.flow + 0.2 * c.capacity + 0.15 * c.velocity);
}

export type Zone = 'healthy' | 'attention' | 'risk' | 'critical';
export function zone(score: number): Zone {
  if (score >= 85) return 'healthy';
  if (score >= 70) return 'attention';
  if (score >= 50) return 'risk';
  return 'critical';
}

// ── скорость (§42) ──

export function velocityDelta(last7: number, prev7: number): number | null {
  if (!prev7) return null;
  return Math.round(((last7 - prev7) / prev7) * 100);
}

// ── прогноз (§37–41) ──

export interface ForecastInput {
  remaining: number;
  /** Закрыто по неделям, от старой к свежей (4 недели). */
  weekly: number[];
  planDate: Date | null;
  now: Date;
}

export interface Forecast {
  /** null — по такой скорости дату назвать нельзя (ничего не закрывают). */
  date: Date | null;
  perWeek: number;
  confidence: number;
  reliable: boolean;
  /** На сколько дней позже плана (минус — раньше); null — плана нет. */
  delayDays: number | null;
  /** Сколько нужно закрывать в неделю, чтобы успеть к плану. */
  neededPerWeek: number | null;
}

/**
 * Прогноз по темпу последних четырёх недель: остаток / задач в неделю.
 *
 * Уверенность — от ровности темпа и того, сколько недель вообще были с закрытиями:
 * четыре одинаковые недели — высокая, одна удачная из четырёх — низкая. Меньше
 * четырёх закрытых задач за месяц — «прогноз пока ненадёжен» (§41), без цифры уверенности.
 */
export function forecast(i: ForecastInput): Forecast {
  const weeks = i.weekly.length || 1;
  const total = i.weekly.reduce((a, b) => a + b, 0);
  const perWeek = total / weeks;
  const mean = perWeek;
  const variance = i.weekly.reduce((a, b) => a + (b - mean) ** 2, 0) / weeks;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
  const active = i.weekly.filter((x) => x > 0).length;
  const reliable = total >= 4 && active >= 2;
  const confidence = reliable ? clamp(Math.round(100 * (1 - Math.min(0.9, cv)) * (active / weeks)), 10, 95) : 0;
  const date = i.remaining === 0 ? i.now : perWeek > 0 ? new Date(i.now.getTime() + (i.remaining / perWeek) * 7 * D) : null;
  let delayDays: number | null = null;
  let neededPerWeek: number | null = null;
  if (i.planDate) {
    if (date) delayDays = Math.round((date.getTime() - i.planDate.getTime()) / D);
    const weeksLeft = (i.planDate.getTime() - i.now.getTime()) / (7 * D);
    neededPerWeek = weeksLeft > 0 ? Math.ceil((i.remaining / weeksLeft) * 10) / 10 : null;
  }
  return { date, perWeek: Math.round(perWeek * 10) / 10, confidence, reliable, delayDays, neededPerWeek };
}

// ── риск проекта (§45) ──

export interface ProjectRiskInput {
  open: number; overdue: number; stuck: number; delayDays: number | null;
  /** Доля открытых задач проекта у перегруженных людей. */
  onOverloaded: number;
  last7: number; prev7: number;
}

export function projectRisk(i: ProjectRiskInput): { score: number; level: 'high' | 'medium' | 'low' } {
  const overdueRatio = i.open ? i.overdue / i.open : 0;
  const stuckRatio = i.open ? i.stuck / i.open : 0;
  const delay = i.delayDays && i.delayDays > 0 ? Math.min(25, i.delayDays * 2) : 0;
  const slowdown = i.prev7 > 0 && i.last7 < i.prev7 * 0.6 ? 10 : 0;
  const score = Math.round(overdueRatio * 40 + stuckRatio * 25 + delay + i.onOverloaded * 10 + slowdown);
  return { score, level: score >= 45 ? 'high' : score >= 20 ? 'medium' : 'low' };
}

// ── вердикт словами (§12, §54, §71) ──

export interface VerdictInput {
  score: number; components: HealthComponents;
  velocityDelta: number | null; last7: number;
  topBottleneck: { title: string; id: string; why: string } | null;
  stuckByColumn: { assignee: string; count: number } | null;
  overloaded: { name: string; pct: number }[];
  decisions: number;
  lateProjects: { name: string; delayDays: number }[];
}

const COMPONENT_TITLE: Record<keyof HealthComponents, string> = {
  delivery: 'закрываем меньше, чем приходит', deadlines: 'просрочки', flow: 'застрявшие задачи',
  capacity: 'перекос загрузки', velocity: 'темп упал',
};

/**
 * Вердикт: что хорошо, где главный затык, что сделать. Тон — «есть риск, который
 * стоит снять сегодня», а не «у вас всё плохо» (§71). Каждое утверждение — из фактов.
 */
export function verdict(i: VerdictInput): { headline: string; lines: string[] } {
  const lines: string[] = [];
  if (i.velocityDelta !== null && i.velocityDelta >= 15) lines.push(`Команда ускорилась: закрыто на ${i.velocityDelta}% больше задач, чем неделей раньше.`);
  else if (i.velocityDelta !== null && i.velocityDelta <= -25) lines.push(`Темп снизился: закрыто на ${Math.abs(i.velocityDelta)}% меньше задач, чем неделей раньше.`);
  else if (i.last7) lines.push(`За неделю закрыто задач: ${i.last7}.`);

  if (i.stuckByColumn && i.stuckByColumn.count >= 2) lines.push(`Главное узкое место — ${i.stuckByColumn.assignee}: застряли ${i.stuckByColumn.count} ${i.stuckByColumn.count < 5 ? 'задачи' : 'задач'}.`);
  else if (i.topBottleneck) lines.push(`Главное узкое место: #${i.topBottleneck.id} «${i.topBottleneck.title}» — ${i.topBottleneck.why.toLowerCase()}.`);
  if (i.overloaded.length) lines.push(`Выше нормы загружены: ${i.overloaded.slice(0, 3).map((p) => `${p.name} (${p.pct}%)`).join(', ')}.`);
  if (i.lateProjects.length) lines.push(`Не успевают к сроку: ${i.lateProjects.slice(0, 2).map((p) => `${p.name} (+${p.delayDays} дн.)`).join(', ')}.`);

  const rec: string[] = [];
  if (i.overloaded.length) rec.push('перераспределить задачи с перегруженных');
  if (i.topBottleneck) rec.push(`снять затык по #${i.topBottleneck.id}`);
  if (i.decisions) rec.push(`принять ${i.decisions} ${i.decisions === 1 ? 'решение' : i.decisions < 5 ? 'решения' : 'решений'}`);
  if (rec.length) lines.push(`Рекомендация: ${rec.join(', ')}.`);

  const weakest = (Object.keys(i.components) as (keyof HealthComponents)[])
    .reduce((a, b) => (i.components[a] <= i.components[b] ? a : b));
  const z = zone(i.score);
  const headline = z === 'healthy'
    ? 'Команда работает стабильно'
    : z === 'attention'
      ? `Есть риски, которые стоит снять сегодня: ${COMPONENT_TITLE[weakest]}`
      : z === 'risk'
        ? `Процессы под угрозой: ${COMPONENT_TITLE[weakest]}`
        : `Нужно вмешательство: ${COMPONENT_TITLE[weakest]}`;
  return { headline, lines };
}

// ── «что сделать, чтобы успеть» (§40) ──

export function catchUpPlan(f: Forecast, i: {
  topBlockers: { id: string; title: string }[]; noAssignee: { id: string; title: string }[]; lowPriority: number;
}): string[] {
  const out: string[] = [];
  if (f.delayDays === null || f.delayDays <= 0) return out;
  if (f.neededPerWeek !== null) out.push(`Закрывать ${f.neededPerWeek} задач в неделю вместо ${f.perWeek}.`);
  for (const t of i.topBlockers.slice(0, 2)) out.push(`Снять затык по #${t.id} «${t.title}».`);
  for (const t of i.noAssignee.slice(0, 2)) out.push(`Назначить исполнителя на #${t.id} «${t.title}».`);
  if (i.lowPriority > 0) out.push(`Вынести из этого срока задачи с низким приоритетом: ${i.lowPriority}.`);
  return out;
}

// ── победы (§43) ──

export function victories(i: { last7: number; prev7: number; completedProjects: string[]; bestWeek: boolean }): string[] {
  const out: string[] = [];
  const delta = velocityDelta(i.last7, i.prev7);
  if (delta !== null && delta >= 20 && i.last7 >= 5) out.push(`Скорость команды выросла на ${delta}%: за неделю закрыто ${i.last7} задач против ${i.prev7}.`);
  for (const p of i.completedProjects.slice(0, 2)) out.push(`Проект «${p}» закрыт полностью.`);
  if (i.bestWeek && i.last7 >= 5) out.push(`Лучшая неделя за два месяца: закрыто ${i.last7} задач.`);
  return out;
}

// ── порядок решений руководителя (§19) ──

export interface Decision {
  kind: 'approval' | 'review' | 'deadline_shift' | 'no_assignee' | 'blocked' | 'client' | 'meeting';
  id: string; title: string; who: string | null; since: Date; dueAt: Date | null;
  taskId: string | null; projectId: string | null; clientId: string | null; urgent: boolean;
}

const KIND_WEIGHT: Record<Decision['kind'], number> = {
  blocked: 6, client: 5, deadline_shift: 5, approval: 4, review: 3, no_assignee: 3, meeting: 2,
};

/** Влияние, срочность, кто ждёт, клиент, сколько ждём (§19) — в одно число для порядка. */
export function decisionScore(d: Decision, now: Date): number {
  const waitingDays = (now.getTime() - d.since.getTime()) / D;
  const dueSoon = d.dueAt ? Math.max(0, 5 - (d.dueAt.getTime() - now.getTime()) / D) : 0;
  return KIND_WEIGHT[d.kind] * 3 + (d.urgent ? 6 : 0) + Math.min(10, waitingDays * 2) + dueSoon * 2;
}

// ── балансировка (§34–36) ──

export interface RebalanceCandidate {
  id: string; name: string; points: number; norm: number;
  skills: string[]; canReceive: boolean; available: boolean;
}

export interface MovableTask {
  id: string; title: string; priority: Priority; deadlineAt: Date | null; inReview: boolean;
  directions: string[];
  /** Кому открыт проект задачи; null — всем сотрудникам. */
  allowed: Set<string> | null;
}

export interface Move { taskId: string; title: string; toId: string; toName: string; reason: string }

/** Сколько очков задача добавляет человеку — та же арифметика, что в loadPoints. */
export function taskPoints(t: Pick<TaskFact, 'priority' | 'deadlineAt'>, now: Date): number {
  return loadPoints({ tasks: [t], reviewsWaiting: 0, meetingHoursToday: 0 }, now).points;
}

/**
 * Кого и чем разгрузить: снимаем с перегруженного то, до чего он дойдёт не скоро
 * (низкий приоритет, дальний срок; сданное на проверку не трогаем), и отдаём тому,
 * у кого после передачи нагрузка останется не выше 85%. Получатель — активный, не в
 * отпуске, принимает задачи автоматически, видит проект и, если у задачи есть
 * направление, работает в нём. Не больше пяти передач за раз — массовую перестановку
 * руководитель не проверит глазами (§35: никаких молчаливых перестановок).
 */
export function pickRebalance(
  from: { id: string; name: string; points: number; norm: number },
  tasks: MovableTask[], candidates: RebalanceCandidate[], now: Date,
): { moves: Move[]; before: number; after: number; loads: Record<string, { before: number; after: number }> } {
  const load = new Map(candidates.map((c) => [c.id, c.points]));
  let fromPoints = from.points;
  const order: Record<Priority, number> = { low: 0, normal: 1, high: 2, urgent: 3 };
  const pool = tasks
    .filter((t) => !t.inReview)
    .sort((a, b) => order[a.priority] - order[b.priority]
      || (b.deadlineAt?.getTime() ?? Infinity) - (a.deadlineAt?.getTime() ?? Infinity));
  const moves: Move[] = [];
  for (const t of pool) {
    if (moves.length >= 5 || fromPoints <= from.norm * 0.9) break;
    const cost = taskPoints(t, now);
    const options = candidates
      .filter((c) => c.id !== from.id && c.canReceive && c.available)
      .filter((c) => !t.allowed || t.allowed.has(c.id))
      .filter((c) => !t.directions.length || t.directions.some((d) => c.skills.includes(d)))
      .map((c) => ({ c, after: ((load.get(c.id) ?? 0) + cost) / c.norm }))
      .filter((o) => o.after <= 0.85)
      .sort((a, b) => a.after - b.after);
    const best = options[0];
    if (!best) continue;
    load.set(best.c.id, (load.get(best.c.id) ?? 0) + cost);
    fromPoints -= cost;
    const skill = t.directions.length ? `работает по направлению «${t.directions.join(', ')}», ` : '';
    moves.push({ taskId: t.id, title: t.title, toId: best.c.id, toName: best.c.name, reason: `${skill}после передачи загрузка ${Math.round(best.after * 100)}%` });
  }
  const loads: Record<string, { before: number; after: number }> = {};
  for (const c of candidates) {
    const before = Math.round((c.points / c.norm) * 100);
    const after = Math.round(((load.get(c.id) ?? c.points) / c.norm) * 100);
    if (before !== after) loads[c.id] = { before, after };
  }
  return { moves, before: Math.round((from.points / from.norm) * 100), after: Math.round((fromPoints / from.norm) * 100), loads };
}
