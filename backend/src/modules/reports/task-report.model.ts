/**
 * Отчёт по задачам за период — расчёт без базы и без вёрстки.
 *
 * Сюда приходят строки задач и часов, отсюда уходит готовая модель отчёта: цифры,
 * сравнение с прошлым таким же периодом, таблицы, списки и выводы словами. Отдельно
 * от SQL и от HTML затем, чтобы правила («что считается выполненным в срок») жили в
 * одном месте и проверялись тестами, а не угадывались по разметке.
 *
 * Правила:
 *  - выполнена — `closed_at` внутри периода (задача, закрытая и снова открытая, считается
 *    по последнему закрытию: история закрытий в базе не хранится);
 *  - в срок — закрыта не позже `deadline_at`; без срока — отдельная корзина, в процент
 *    «в срок» не входит, иначе задачи без срока молча делали бы картину лучше;
 *  - открыта на момент T — создана раньше T и не закрыта к T;
 *  - просрочена на момент T — открыта на T и её срок раньше T;
 *  - «на конец периода» — это конец периода или сейчас, если период ещё идёт.
 */

export interface ReportTaskRow {
  id: string;
  title: string;
  project_id: string;
  project_name: string;
  assignee_id: string | null;
  assignee_name: string | null;
  creator_name: string | null;
  priority: string | null;
  created_at: Date | string;
  closed_at: Date | string | null;
  deadline_at: Date | string | null;
  status: string | null;
  approval_state: string | null;
  tags: string[] | null;
}

export interface ReportHoursRow {
  task_id: string;
  user_id: string;
  user_name: string | null;
  project_id: string;
  cur_hours: number | string;
  prev_hours: number | string;
}

export interface ReportInput {
  companyName: string;
  logoDataUri: string | null;
  timezone: string;
  /** Даты периода включительно, как их выбрал человек: YYYY-MM-DD. */
  from: string;
  to: string;
  /** Границы периода и прошлого такого же периода (полуинтервалы [start, end)). */
  start: Date;
  end: Date;
  prevStart: Date;
  prevEnd: Date;
  now: Date;
  generatedBy: string;
  scope: { projectName: string | null; personName: string | null };
  tasks: ReportTaskRow[];
  hours: ReportHoursRow[];
  /** Учёт времени в компании вообще ведётся — иначе колонку часов не показываем. */
  tracksTime: boolean;
}

export interface Kpi {
  key: string;
  label: string;
  value: number | null;
  prev: number | null;
  /** Как читать: 'num' — штуки, 'pct' — проценты, 'days' — дни, 'hours' — часы. */
  unit: 'num' | 'pct' | 'days' | 'hours';
  /** Рост — это хорошо (выполнено) или плохо (просрочено)? Для подсветки сравнения. */
  goodWhenUp: boolean | null;
  hint: string;
}

export interface TrendBucket { label: string; created: number; completed: number }

export interface GroupRow {
  name: string;
  created: number;
  completed: number;
  onTimePct: number | null;
  overdueEnd: number;
  openEnd: number;
  hours: number;
  leadDays: number | null;
}

export interface TaskLine {
  id: string;
  title: string;
  project: string;
  assignee: string;
  deadline: Date | null;
  closed: Date | null;
  /** Для выполненных: в срок / просрочка N дн. / без срока. Для открытых: дней просрочки. */
  verdict: 'ontime' | 'late' | 'nodeadline' | 'overdue' | 'soon' | 'review';
  days: number | null;
  hours: number;
}

export interface TaskReport {
  title: string;
  companyName: string;
  logoDataUri: string | null;
  timezone: string;
  periodLabel: string;
  prevLabel: string;
  scopeLabel: string;
  generatedAt: Date;
  generatedBy: string;
  /** Период ещё идёт — «на конец периода» значит «сейчас». */
  ongoing: boolean;
  snapshot: Date;
  kpis: Kpi[];
  insights: string[];
  trend: { unit: 'day' | 'week' | 'month'; buckets: TrendBucket[] };
  quality: { onTime: number; late: number; noDeadline: number };
  byPriority: { key: string; label: string; count: number }[];
  byTag: { name: string; count: number }[];
  projects: GroupRow[];
  people: GroupRow[];
  completed: TaskLine[];
  completedTotal: number;
  overdue: TaskLine[];
  overdueTotal: number;
  soon: TaskLine[];
  review: TaskLine[];
  topHours: TaskLine[];
  showHours: boolean;
  empty: boolean;
}

const DAY = 86_400_000;
/** Сколько строк в списках: дальше PDF превращается в справочник, а не в отчёт. */
export const LIST_LIMITS = { completed: 300, overdue: 150, soon: 100, review: 50, topHours: 10 };
const SOON_DAYS = 3;

const PRIORITY_LABEL: Record<string, string> = {
  urgent: 'Срочный', high: 'Высокий', normal: 'Обычный', low: 'Низкий',
};

const d = (v: Date | string | null | undefined): Date | null => (v ? new Date(v) : null);
const num = (v: number | string | null | undefined) => Number(v) || 0;
const round1 = (v: number) => Math.round(v * 10) / 10;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Местная дата в поясе компании: границы дней и недель — её, а не сервера. */
function localParts(at: Date, tz: string): { y: number; m: number; d: number; wd: number } {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  const wd = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday);
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), wd };
}

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

/** «1–30 сентября 2026», «28 сентября – 4 октября 2026», «Сентябрь 2026». */
export function periodLabel(from: string, to: string): string {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  if (fy === ty && fm === tm && fd === 1 && td === lastDay) return `${MONTHS_NOM[fm - 1]} ${fy}`;
  const gen = (m: number) => ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'][m - 1];
  if (fy === ty && fm === tm) return fd === td ? `${fd} ${gen(fm)} ${fy}` : `${fd}–${td} ${gen(fm)} ${fy}`;
  if (fy === ty) return `${fd} ${gen(fm)} – ${td} ${gen(tm)} ${fy}`;
  return `${fd} ${gen(fm)} ${fy} – ${td} ${gen(tm)} ${ty}`;
}

/** Столбики графика: по дням до месяца, по неделям до полугода, дальше по месяцам. */
function buckets(start: Date, end: Date, tz: string): { unit: 'day' | 'week' | 'month'; keyOf: (at: Date) => string; list: { key: string; label: string }[] } {
  const days = Math.round((end.getTime() - start.getTime()) / DAY);
  const unit: 'day' | 'week' | 'month' = days <= 31 ? 'day' : days <= 190 ? 'week' : 'month';
  const keyOf = (at: Date) => {
    const p = localParts(at, tz);
    if (unit === 'month') return `${p.y}-${String(p.m).padStart(2, '0')}`;
    const base = Date.UTC(p.y, p.m - 1, p.d) - (unit === 'week' ? p.wd * DAY : 0);
    return new Date(base).toISOString().slice(0, 10);
  };
  const list: { key: string; label: string }[] = [];
  const seen = new Set<string>();
  for (let t = start.getTime(); t < end.getTime(); t += unit === 'month' ? DAY * 27 : DAY) {
    const key = keyOf(new Date(t));
    if (seen.has(key)) continue;
    seen.add(key);
    const [y, m, dd] = key.split('-').map(Number);
    list.push({
      key,
      label: unit === 'month' ? `${MONTHS_SHORT[m - 1]} ${String(y).slice(2)}` : `${dd} ${MONTHS_SHORT[m - 1]}`,
    });
  }
  return { unit, keyOf, list };
}

interface Window { start: Date; end: Date; snap: Date }

function within(at: Date | null, w: Window) {
  return !!at && at >= w.start && at < w.end;
}
function openAt(t: ReportTaskRow, at: Date) {
  const c = d(t.created_at)!; const cl = d(t.closed_at);
  return c < at && (!cl || cl >= at);
}
function overdueAt(t: ReportTaskRow, at: Date) {
  const dl = d(t.deadline_at);
  return openAt(t, at) && !!dl && dl < at;
}

function stats(tasks: ReportTaskRow[], w: Window) {
  const created = tasks.filter((t) => within(d(t.created_at), w)).length;
  const done = tasks.filter((t) => within(d(t.closed_at), w));
  let onTime = 0; let late = 0; let noDeadline = 0;
  for (const t of done) {
    const dl = d(t.deadline_at);
    if (!dl) noDeadline++;
    else if (d(t.closed_at)! <= dl) onTime++;
    else late++;
  }
  const lead = median(done.map((t) => (d(t.closed_at)!.getTime() - d(t.created_at)!.getTime()) / DAY));
  return {
    created,
    completed: done.length,
    onTime, late, noDeadline,
    onTimePct: onTime + late > 0 ? Math.round((onTime / (onTime + late)) * 100) : null,
    openEnd: tasks.filter((t) => openAt(t, w.snap)).length,
    overdueEnd: tasks.filter((t) => overdueAt(t, w.snap)).length,
    leadDays: lead === null ? null : round1(lead),
  };
}

function pct(a: number, b: number) { return b > 0 ? Math.round(((a - b) / b) * 100) : null; }
function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10; const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
const tasksWord = (n: number) => plural(n, 'задача', 'задачи', 'задач');

export function buildTaskReport(input: ReportInput): TaskReport {
  const { tasks, tz = 'Europe/Moscow' } = { tasks: input.tasks, tz: input.timezone };
  const ongoing = input.end > input.now;
  const cur: Window = { start: input.start, end: input.end, snap: ongoing ? input.now : input.end };
  const prev: Window = { start: input.prevStart, end: input.prevEnd, snap: input.prevEnd };
  const s = stats(tasks, cur);
  const p = stats(tasks, prev);

  const hoursByTask = new Map<string, number>();
  const hoursByUser = new Map<string, { name: string; hours: number }>();
  const hoursByProject = new Map<string, number>();
  let hoursCur = 0; let hoursPrev = 0;
  for (const h of input.hours) {
    const ch = num(h.cur_hours);
    hoursCur += ch; hoursPrev += num(h.prev_hours);
    if (!ch) continue;
    hoursByTask.set(h.task_id, (hoursByTask.get(h.task_id) ?? 0) + ch);
    const u = hoursByUser.get(h.user_id) ?? { name: h.user_name ?? 'Без имени', hours: 0 };
    u.hours += ch; hoursByUser.set(h.user_id, u);
    hoursByProject.set(h.project_id, (hoursByProject.get(h.project_id) ?? 0) + ch);
  }
  const showHours = input.tracksTime && hoursCur > 0;

  const kpis: Kpi[] = [
    { key: 'created', label: 'Поставлено', value: s.created, prev: p.created, unit: 'num', goodWhenUp: null, hint: 'новых задач за период' },
    { key: 'completed', label: 'Выполнено', value: s.completed, prev: p.completed, unit: 'num', goodWhenUp: true, hint: 'закрыто за период' },
    { key: 'ontime', label: 'В срок', value: s.onTimePct, prev: p.onTimePct, unit: 'pct', goodWhenUp: true, hint: 'выполненных задач со сроком' },
    { key: 'overdue', label: 'Просрочено', value: s.overdueEnd, prev: p.overdueEnd, unit: 'num', goodWhenUp: false, hint: ongoing ? 'открытых задач сейчас' : 'открытых на конец периода' },
    { key: 'open', label: 'В работе', value: s.openEnd, prev: p.openEnd, unit: 'num', goodWhenUp: null, hint: ongoing ? 'открытых задач сейчас' : 'открытых на конец периода' },
    { key: 'lead', label: 'Срок выполнения', value: s.leadDays, prev: p.leadDays, unit: 'days', goodWhenUp: false, hint: 'медиана от постановки до закрытия' },
  ];
  if (showHours) {
    kpis.push({ key: 'hours', label: 'Затрачено', value: round1(hoursCur), prev: round1(hoursPrev), unit: 'hours', goodWhenUp: null, hint: 'часов по учёту времени' });
  }

  // динамика
  const b = buckets(input.start, input.end, tz);
  const trendMap = new Map(b.list.map((x) => [x.key, { label: x.label, created: 0, completed: 0 }]));
  for (const t of tasks) {
    const c = d(t.created_at)!;
    if (within(c, cur)) { const k = trendMap.get(b.keyOf(c)); if (k) k.created++; }
    const cl = d(t.closed_at);
    if (within(cl, cur)) { const k = trendMap.get(b.keyOf(cl!)); if (k) k.completed++; }
  }

  const completedTasks = tasks.filter((t) => within(d(t.closed_at), cur));

  // приоритеты и теги выполненного
  const byPriority = ['urgent', 'high', 'normal', 'low'].map((key) => ({
    key, label: PRIORITY_LABEL[key],
    count: completedTasks.filter((t) => (t.priority || 'normal') === key).length,
  }));
  const tagCount = new Map<string, number>();
  for (const t of completedTasks) for (const tag of t.tags ?? []) tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1);
  const byTag = [...tagCount.entries()].map(([name, count]) => ({ name, count }))
    .sort((a, b2) => b2.count - a.count).slice(0, 8);

  // таблицы по проектам и людям
  const group = (keyOf: (t: ReportTaskRow) => string, nameOf: (t: ReportTaskRow) => string, hoursOf: (key: string) => number): GroupRow[] => {
    const keys = new Map<string, string>();
    for (const t of tasks) {
      if (within(d(t.created_at), cur) || within(d(t.closed_at), cur) || openAt(t, cur.snap)) keys.set(keyOf(t), nameOf(t));
    }
    return [...keys.entries()].map(([key, name]) => {
      const st = stats(tasks.filter((t) => keyOf(t) === key), cur);
      return {
        name, created: st.created, completed: st.completed, onTimePct: st.onTimePct,
        overdueEnd: st.overdueEnd, openEnd: st.openEnd, hours: round1(hoursOf(key)), leadDays: st.leadDays,
      };
    }).sort((a, b2) => b2.completed - a.completed || b2.openEnd - a.openEnd || a.name.localeCompare(b2.name, 'ru'));
  };
  const projects = group((t) => t.project_id, (t) => t.project_name, (k) => hoursByProject.get(k) ?? 0);
  const people = group((t) => t.assignee_id ?? '—', (t) => t.assignee_name ?? 'Без исполнителя', (k) => hoursByUser.get(k)?.hours ?? 0);

  // списки
  const line = (t: ReportTaskRow, verdict: TaskLine['verdict'], days: number | null): TaskLine => ({
    id: String(t.id), title: t.title, project: t.project_name, assignee: t.assignee_name ?? '—',
    deadline: d(t.deadline_at), closed: d(t.closed_at), verdict, days, hours: round1(hoursByTask.get(String(t.id)) ?? 0),
  });
  const completed = completedTasks
    .sort((a, b2) => d(a.closed_at)!.getTime() - d(b2.closed_at)!.getTime())
    .map((t) => {
      const dl = d(t.deadline_at); const cl = d(t.closed_at)!;
      if (!dl) return line(t, 'nodeadline', null);
      if (cl <= dl) return line(t, 'ontime', null);
      return line(t, 'late', Math.ceil((cl.getTime() - dl.getTime()) / DAY));
    });
  const overdueAll = tasks.filter((t) => overdueAt(t, cur.snap))
    .sort((a, b2) => d(a.deadline_at)!.getTime() - d(b2.deadline_at)!.getTime())
    .map((t) => line(t, 'overdue', Math.ceil((cur.snap.getTime() - d(t.deadline_at)!.getTime()) / DAY)));
  const soon = tasks.filter((t) => {
    const dl = d(t.deadline_at);
    return openAt(t, cur.snap) && !!dl && dl >= cur.snap && dl.getTime() < cur.snap.getTime() + SOON_DAYS * DAY;
  }).sort((a, b2) => d(a.deadline_at)!.getTime() - d(b2.deadline_at)!.getTime())
    .slice(0, LIST_LIMITS.soon)
    .map((t) => line(t, 'soon', Math.max(0, Math.ceil((d(t.deadline_at)!.getTime() - cur.snap.getTime()) / DAY))));
  // «ждёт приёмки» — состояние на сейчас: прошлое в базе не хранится, поэтому только для идущего периода
  const review = ongoing
    ? tasks.filter((t) => !t.closed_at && t.approval_state === 'pending').slice(0, LIST_LIMITS.review).map((t) => line(t, 'review', null))
    : [];
  const topHours = showHours
    ? tasks.filter((t) => (hoursByTask.get(String(t.id)) ?? 0) > 0)
      .sort((a, b2) => (hoursByTask.get(String(b2.id)) ?? 0) - (hoursByTask.get(String(a.id)) ?? 0))
      .slice(0, LIST_LIMITS.topHours)
      .map((t) => line(t, t.closed_at ? 'ontime' : 'soon', null))
    : [];

  const insights = buildInsights(s, p, projects, people, completedTasks.length);

  const scopeLabel = [input.scope.projectName ? `Проект «${input.scope.projectName}»` : null,
    input.scope.personName ? `Исполнитель: ${input.scope.personName}` : null].filter(Boolean).join(' · ') || 'Вся компания';

  return {
    title: 'Отчёт по задачам',
    companyName: input.companyName,
    logoDataUri: input.logoDataUri,
    timezone: tz,
    periodLabel: periodLabel(input.from, input.to),
    prevLabel: periodLabel(
      new Date(input.prevStart.getTime() + 12 * 3600_000).toISOString().slice(0, 10),
      new Date(input.prevEnd.getTime() - 12 * 3600_000).toISOString().slice(0, 10),
    ),
    scopeLabel,
    generatedAt: input.now,
    generatedBy: input.generatedBy,
    ongoing,
    snapshot: cur.snap,
    kpis,
    insights,
    trend: { unit: b.unit, buckets: [...trendMap.values()] },
    quality: { onTime: s.onTime, late: s.late, noDeadline: s.noDeadline },
    byPriority,
    byTag,
    projects,
    people,
    completed: completed.slice(0, LIST_LIMITS.completed),
    completedTotal: completed.length,
    overdue: overdueAll.slice(0, LIST_LIMITS.overdue),
    overdueTotal: overdueAll.length,
    soon,
    review,
    topHours,
    showHours,
    empty: s.created === 0 && s.completed === 0 && s.openEnd === 0,
  };
}

/**
 * Выводы словами — правилами, а не моделью.
 *
 * Отчёт уходит руководителю и дальше, и в нём не должно быть ни одной фразы, которую
 * нельзя проверить по цифрам на этой же странице. Поэтому каждый вывод — из таблиц выше.
 */
function buildInsights(
  s: ReturnType<typeof stats>, p: ReturnType<typeof stats>,
  projects: GroupRow[], people: GroupRow[], completedCount: number,
): string[] {
  const out: string[] = [];
  if (s.completed > 0) {
    const ch = pct(s.completed, p.completed);
    out.push(ch === null || p.completed === 0
      ? `Выполнено ${s.completed} ${tasksWord(s.completed)}.`
      : `Выполнено ${s.completed} ${tasksWord(s.completed)} — ${ch === 0 ? 'столько же, сколько' : ch > 0 ? `на ${ch}% больше, чем` : `на ${-ch}% меньше, чем`} за прошлый период (${p.completed}).`);
  } else {
    out.push('За период не закрыто ни одной задачи.');
  }
  if (s.onTimePct !== null) {
    const diff = p.onTimePct !== null ? s.onTimePct - p.onTimePct : null;
    out.push(`В срок закрыто ${s.onTimePct}% задач со сроком${diff === null || diff === 0 ? '' : diff > 0 ? ` — на ${diff} п.п. лучше прошлого периода` : ` — на ${-diff} п.п. хуже прошлого периода`}.`);
  }
  if (s.created > 0 || s.completed > 0) {
    const delta = s.created - s.completed;
    if (delta > 0) out.push(`Поставлено больше, чем выполнено: очередь выросла на ${delta} ${tasksWord(delta)}.`);
    else if (delta < 0) out.push(`Выполнено больше, чем поставлено: очередь сократилась на ${-delta} ${tasksWord(-delta)}.`);
    else out.push('Поставлено и выполнено поровну — очередь не изменилась.');
  }
  if (s.overdueEnd > 0) {
    const worst = [...projects].sort((a, b) => b.overdueEnd - a.overdueEnd)[0];
    out.push(projects.length > 1 && worst?.overdueEnd
      ? `Просрочено ${s.overdueEnd} ${tasksWord(s.overdueEnd)}; больше всего — в проекте «${worst.name}» (${worst.overdueEnd}).`
      : `Просрочено ${s.overdueEnd} ${tasksWord(s.overdueEnd)} — список в конце отчёта.`);
  }
  const named = people.filter((x) => x.name !== 'Без исполнителя');
  if (named.length > 1) {
    const top = [...named].sort((a, b) => b.completed - a.completed)[0];
    if (top?.completed) out.push(`Больше всего задач закрыто у сотрудника ${top.name}: ${top.completed}.`);
    const loaded = [...named].sort((a, b) => b.openEnd - a.openEnd)[0];
    if (loaded?.openEnd) {
      out.push(`Больше всего открытых задач у сотрудника ${loaded.name}: ${loaded.openEnd}${loaded.overdueEnd ? `, из них просрочено ${loaded.overdueEnd}` : ''}.`);
    }
  }
  const unassigned = people.find((x) => x.name === 'Без исполнителя');
  if (unassigned?.openEnd) out.push(`Без исполнителя ${unassigned.openEnd} ${tasksWord(unassigned.openEnd)} — их никто не делает.`);
  if (s.leadDays !== null) out.push(`Задача в среднем выполняется за ${String(s.leadDays).replace('.', ',')} дн. (медиана от постановки до закрытия).`);
  if (completedCount >= 5 && s.noDeadline / completedCount > 0.3) {
    out.push(`У ${Math.round((s.noDeadline / completedCount) * 100)}% выполненных задач не было срока — по ним нельзя судить о соблюдении сроков.`);
  }
  return out.slice(0, 8);
}
