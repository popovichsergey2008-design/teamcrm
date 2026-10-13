/**
 * Счётчики изменений по задачам (ТЗ-32) — правила без базы.
 *
 * Считаем по ИСТОРИИ переходов (task_status_transitions), а не по текущему статусу:
 * задача, которая сегодня сходила в тест, вернулась и снова ушла, — это два перехода
 * в тест, один возврат и одна уникальная задача (§10).
 *
 * Возврат из проверки — событие процесса, а не оценка работы (§19): здесь только счёт.
 */

export type Stage = 'work' | 'testing' | 'review' | 'approval' | 'waiting_external' | 'done' | 'blocked';

export type ChangeKind =
  | 'entered_testing'
  | 'returned_to_work'
  | 'moved_to_done'
  | 'reopened'
  | 'blocked'
  | 'unblocked';

export const CHANGE_KINDS: ChangeKind[] = ['entered_testing', 'returned_to_work', 'moved_to_done', 'reopened', 'blocked', 'unblocked'];

export const CHANGE_LABEL: Record<ChangeKind, string> = {
  entered_testing: 'На тестирование',
  returned_to_work: 'Возвращено в работу',
  moved_to_done: 'В готовое',
  reopened: 'Переоткрыто',
  blocked: 'Заблокировано',
  unblocked: 'Разблокировано',
};

/** «На проверке» в широком смысле: тест, ревью, приёмка. Возврат оттуда в работу — возврат. */
const CHECKING: Stage[] = ['testing', 'review', 'approval'];

/** Какие счётчики задевает один переход (§9). Один переход может попасть в два: done → testing — и «переоткрыто», и «на тест». */
export function kindsOf(from: string, to: string): ChangeKind[] {
  const out: ChangeKind[] = [];
  if (from === to) return out;
  if (to === 'testing') out.push('entered_testing');
  if (CHECKING.includes(from as Stage) && to === 'work') out.push('returned_to_work');
  if (to === 'done') out.push('moved_to_done');
  if (from === 'done') out.push('reopened');
  if (to === 'blocked') out.push('blocked');
  if (from === 'blocked') out.push('unblocked');
  return out;
}

export interface TransitionRow {
  taskId: string;
  actorId: string | null;
  assigneeId: string | null;
  from: string;
  to: string;
}

export type Counts = Record<ChangeKind, number>;
const zero = (): Counts => ({ entered_testing: 0, returned_to_work: 0, moved_to_done: 0, reopened: 0, blocked: 0, unblocked: 0 });

export interface ChangeSummary {
  totals: Counts;
  /** Уникальных задач на каждый счётчик (§10). */
  unique: Counts;
  /** По людям: by='actor' — кто двигал; by='assignee' — чья задача (§4, §11). */
  users: { userId: string | null; counts: Counts; total: number }[];
  transitions: number;
}

export function summarize(rows: TransitionRow[], by: 'actor' | 'assignee' = 'actor'): ChangeSummary {
  const totals = zero();
  const uniqueSets: Record<ChangeKind, Set<string>> = {
    entered_testing: new Set(), returned_to_work: new Set(), moved_to_done: new Set(),
    reopened: new Set(), blocked: new Set(), unblocked: new Set(),
  };
  const perUser = new Map<string, Counts>();
  for (const r of rows) {
    const kinds = kindsOf(r.from, r.to);
    if (!kinds.length) continue;
    const who = String((by === 'actor' ? r.actorId : r.assigneeId) ?? '');
    const c = perUser.get(who) ?? zero();
    for (const k of kinds) {
      totals[k] += 1;
      uniqueSets[k].add(String(r.taskId));
      c[k] += 1;
    }
    perUser.set(who, c);
  }
  const unique = zero();
  for (const k of CHANGE_KINDS) unique[k] = uniqueSets[k].size;
  const users = [...perUser.entries()]
    .map(([userId, counts]) => ({ userId: userId || null, counts, total: CHANGE_KINDS.reduce((s, k) => s + counts[k], 0) }))
    .sort((a, b) => b.total - a.total || b.counts.entered_testing - a.counts.entered_testing);
  return { totals, unique, users, transitions: rows.length };
}

/** Условие SQL для одного вида (детализация по клику) — та же логика, что kindsOf. */
export function kindSql(kind: ChangeKind, a = 'x'): string {
  switch (kind) {
    case 'entered_testing': return `(${a}.to_stage = 'testing' AND ${a}.from_stage <> 'testing')`;
    case 'returned_to_work': return `(${a}.from_stage IN ('testing','review','approval') AND ${a}.to_stage = 'work')`;
    case 'moved_to_done': return `(${a}.to_stage = 'done' AND ${a}.from_stage <> 'done')`;
    case 'reopened': return `(${a}.from_stage = 'done' AND ${a}.to_stage <> 'done')`;
    case 'blocked': return `(${a}.to_stage = 'blocked' AND ${a}.from_stage <> 'blocked')`;
    case 'unblocked': return `(${a}.from_stage = 'blocked' AND ${a}.to_stage <> 'blocked')`;
  }
}

/** Доля возвратов (§20) — только справочно, не KPI сотрудника. */
export const returnRate = (c: Counts) => (c.entered_testing ? Math.round((c.returned_to_work / c.entered_testing) * 100) : null);
