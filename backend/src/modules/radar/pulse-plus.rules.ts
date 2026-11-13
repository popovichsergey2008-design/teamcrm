/**
 * «Пульс команды» по ТЗ #4890 — чистые правила экрана: метки нагрузки без процентов,
 * часы только из оценок, прогноз диапазоном, стоящие проекты, три шага с эффектом,
 * текст сообщения по группе задач, чек-лист новой команды.
 */

const D = 86_400_000;

export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100; const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

// ── п. 9: нагрузка без процентов ──

export type LoadLabel = 'reviews' | 'overdue' | 'spare' | 'normal';
export const LOAD_TITLE: Record<LoadLabel, string> = {
  reviews: 'перегружен проверками', overdue: 'много просрочек', spare: 'есть запас', normal: 'в норме',
};

/**
 * Метка состояния вместо процентов (проценты считались по числу задач и не означали
 * время). Проверки — первыми: у руководителя с 90 непроверенными работами «своих» задач
 * может быть пять, но тормозит он команду именно проверками.
 */
export function loadLabel(i: { reviews: number; active: number; overdue: number; points: number; norm: number }): LoadLabel {
  if (i.reviews >= 10 && i.reviews >= i.active) return 'reviews';
  if (i.overdue >= 3 || (i.overdue >= 2 && i.active > 0 && i.overdue / i.active >= 0.3)) return 'overdue';
  if (i.points < i.norm * 0.6 && i.overdue === 0) return 'spare';
  return 'normal';
}

/** «30 ч из 25 доступных · оценки есть у 3 из 4 задач» — часы только из оценок (п. 9). */
export function hoursLine(i: { estimated: number; withEstimate: number; total: number; available: number }): string {
  if (!i.total) return `задач на неделю нет · доступно ${fmtH(i.available)}`;
  if (!i.withEstimate) return `оценок нет ни у одной из ${i.total} ${plural(i.total, 'задачи', 'задач', 'задач')} — часы не считаем`;
  return `${fmtH(i.estimated)} из ${fmtH(i.available)} доступных · оценки есть у ${i.withEstimate} из ${i.total} ${plural(i.total, 'задачи', 'задач', 'задач')}`;
}
const fmtH = (h: number) => `${Math.round(h * 10) / 10} ч`.replace('.', ',');

/** Сколько рабочих часов в ближайшие 7 дней: рабочие дни × длина дня − встречи. */
export function availableHours(i: { workStart: string; workEnd: string; weekendDays: number[]; meetingHours: number; now: Date; lunchMin?: number }): number {
  const [sh, sm] = i.workStart.split(':').map(Number); const [eh, em] = i.workEnd.split(':').map(Number);
  const dayH = Math.max(0, ((eh || 0) * 60 + (em || 0) - (sh || 0) * 60 - (sm || 0) - (i.lunchMin ?? 60)) / 60);
  let days = 0;
  for (let k = 0; k < 7; k++) {
    const d = new Date(i.now.getTime() + k * D);
    if (!i.weekendDays.includes(d.getUTCDay())) days += 1;
  }
  return Math.max(0, Math.round((days * dayH - i.meetingHours) * 10) / 10);
}

// ── п. 10: прогноз только там, где он есть ──

export interface RangeForecast { kind: 'range' | 'approx'; from: string; to: string; text: string }

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const dm = (d: Date) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;

/** «3–20 января», «28 декабря – 15 января». */
export function formatRange(a: Date, b: Date): string {
  if (a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth()) {
    return a.getUTCDate() === b.getUTCDate() ? dm(a) : `${a.getUTCDate()}–${dm(b)}`;
  }
  return `${dm(a)} – ${dm(b)}`;
}

/**
 * Дата диапазоном вместо процента уверенности. Темп недели скачет: быстрый край — средний
 * темп плюс разброс, медленный — минус разброс (но не меньше половины среднего). Мало
 * данных (меньше 4 закрытых за 4 недели или одна неделя с закрытиями) — «≈ дата».
 * Ничего не закрывают — прогноза нет (null): такой проект на экране не показываем с «не назвать».
 */
export function forecastRange(i: { weekly: number[]; remaining: number; now: Date }): RangeForecast | null {
  const weeks = i.weekly.length || 1;
  const total = i.weekly.reduce((a, b) => a + b, 0);
  const mean = total / weeks;
  if (i.remaining <= 0 || mean <= 0) return null;
  const sd = Math.sqrt(i.weekly.reduce((a, b) => a + (b - mean) ** 2, 0) / weeks);
  const active = i.weekly.filter((x) => x > 0).length;
  const at = (perWeek: number) => new Date(i.now.getTime() + (i.remaining / perWeek) * 7 * D);
  if (total < 4 || active < 2) {
    const d = at(mean);
    return { kind: 'approx', from: d.toISOString().slice(0, 10), to: d.toISOString().slice(0, 10), text: `≈ ${dm(d)}` };
  }
  const fast = at(mean + sd);
  const slow = at(Math.max(mean - sd, mean / 2));
  return { kind: 'range', from: fast.toISOString().slice(0, 10), to: slow.toISOString().slice(0, 10), text: formatRange(fast, slow) };
}

/** Проект стоит 4+ недели: открытые задачи есть, за 4 недели не закрыто ни одной и ничего не двигалось. */
export function isStale(i: { open: number; weekly: number[]; lastMove: Date | null; now: Date }): boolean {
  if (i.open <= 0) return false;
  if (i.weekly.some((x) => x > 0)) return false;
  return !i.lastMove || i.now.getTime() - i.lastMove.getTime() >= 28 * D;
}

// ── п. 7: три шага с наибольшим эффектом ──

export type StepKind = 'nudge' | 'stale' | 'balance' | 'remind_review' | 'assign';

export interface Step {
  kind: StepKind; key: string; title: string; detail: string; effect: number; button: string;
  userId?: string | null; userName?: string | null; toId?: string | null; toName?: string | null;
  taskIds?: string[]; projectIds?: string[];
}

/** По эффекту на индекс, при равенстве — по числу задач в шаге. У каждого шага одна кнопка. */
export function topSteps(steps: Step[], n = 3): Step[] {
  return [...steps].sort((a, b) => b.effect - a.effect || (b.taskIds?.length ?? b.projectIds?.length ?? 0) - (a.taskIds?.length ?? a.projectIds?.length ?? 0)).slice(0, n);
}

// ── п. 8: одно сообщение на группу задач ──

export interface MsgTask { id: string; title: string; days: number }

const short = (s: string, max = 70) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const first = (name: string) => name.trim().split(/\s+/)[0] || name;

/** Готовый текст правилами — запасной путь без ИИ и образец для модели. */
export function statusMessage(i: { name: string; kind: 'overdue' | 'review' | 'stale'; tasks: MsgTask[] }): string {
  const head = i.kind === 'review'
    ? `${first(i.name)}, привет! Посмотри, пожалуйста, задачи, которые ждут твоей проверки:`
    : `${first(i.name)}, привет! Посмотри, пожалуйста, статус по задачам, у которых прошёл срок:`;
  const line = (t: MsgTask) => i.kind === 'review'
    ? `• #${t.id} ${short(t.title)} — ждёт ${t.days} ${plural(t.days, 'день', 'дня', 'дней')}`
    : `• #${t.id} ${short(t.title)} — срок прошёл ${t.days} ${plural(t.days, 'день', 'дня', 'дней')} назад`;
  const ask = i.kind === 'review'
    ? 'Сможешь принять или вернуть их сегодня? Если какую-то не успеваешь — скажи, передадим.'
    : 'По каждой: что осталось и когда реально сдашь? Если задача уже не нужна — напиши, закроем.';
  return [head, ...i.tasks.slice(0, 30).map(line), ask].join('\n');
}

/** Текст модели годится, только если в нём все номера задач группы и нет чужих. */
export function messageGrounded(text: string, taskIds: string[]): boolean {
  const t = text.trim();
  if (t.length < 20 || t.length > 4000) return false;
  const nums = new Set((t.match(/#(\d+)/g) ?? []).map((x) => x.slice(1)));
  return taskIds.every((id) => nums.has(id)) && [...nums].every((n) => taskIds.includes(n));
}

// ── п. 11: экран новой команды ──

export interface TrialFacts { colleagues: number; invites: number; tasksWithDeadline: number; reviewerSet: boolean; closed: number }

export interface TrialStep { key: 'invite' | 'tasks' | 'reviewer' | 'close'; title: string; enables: string; done: boolean; progress: string }

export function trialSteps(f: TrialFacts): TrialStep[] {
  const invited = f.colleagues + f.invites;
  return [
    { key: 'invite', title: 'Пригласить 3 коллег', enables: 'включает «Загрузку»', done: invited >= 3, progress: `${Math.min(invited, 3)} из 3` },
    { key: 'tasks', title: 'Создать 10 задач со сроками', enables: 'включает «Сроки»', done: f.tasksWithDeadline >= 10, progress: `${Math.min(f.tasksWithDeadline, 10)} из 10` },
    { key: 'reviewer', title: 'Назначить проверяющего хотя бы в одном проекте', enables: 'включает «Движение задач»', done: f.reviewerSet, progress: f.reviewerSet ? 'есть' : 'нет' },
    { key: 'close', title: 'Закрыть первые 5 задач', enables: 'включает «Скорость» и прогноз', done: f.closed >= 5, progress: `${Math.min(f.closed, 5)} из 5` },
  ];
}

/**
 * Показывать экран новой команды: пока не все 4 шага сделаны и данных мало. Команде,
 * которая давно работает (закрыто 50+ задач), обычный Пульс не прячем, даже если у неё,
 * например, всего два человека.
 */
export function showTrial(f: TrialFacts): boolean {
  return f.closed < 50 && trialSteps(f).some((s) => !s.done);
}
