/**
 * Ответственность за срок (ТЗ-30) — ОДИН источник правды для всей системы.
 *
 * Просрочка задачи и просрочка человека — разные вещи (п. 4). Задача за сроком
 * остаётся просроченной для проекта, но исполнитель, сдавший работу на проверку,
 * согласование или ожидание клиента, больше не «просрочивает» — задержка теперь на
 * этапе и у того, кто её держит (постановщика — решение 12.10).
 *
 * Этап задачи считает база (`task_stage()` из миграции 0180): закрыта — «готово»,
 * ждёт приёмки — «согласование», иначе — тип колонки. Отметки «сдал / вернули /
 * срок доработки» ставит триггер на задаче, поэтому не важно, кто её двигал.
 *
 * Все модули берут формулы отсюда: Пульс, Фокус, брифы, напоминания, отчёты. Своих
 * «deadline < now() AND closed_at IS NULL» для человека больше нигде быть не должно.
 */

export type Stage = 'work' | 'testing' | 'review' | 'approval' | 'waiting_external' | 'done';
export const PAUSED_STAGES: Stage[] = ['testing', 'review', 'approval', 'waiting_external'];
export const STAGES: Stage[] = ['work', 'testing', 'review', 'approval', 'waiting_external', 'done'];
const PAUSED_SQL = `('testing', 'review', 'approval', 'waiting_external')`;

// ── SQL (t — алиас таблицы tasks) ──

/** Этап задачи — через функцию базы: колонку присоединять не нужно. */
export const stageSql = (t = 't') => `task_stage(${t}.column_id, ${t}.approval_state, ${t}.closed_at)`;

/** Работа сдана и ждёт другого: проверка, согласование, клиент. */
export const pausedSql = (t = 't') => `(${stageSql(t)} IN ${PAUSED_SQL})`;

/** Сейчас должен исполнитель: задача у него в работе. */
export const assigneeOwesSql = (t = 't') => `(${stageSql(t)} = 'work')`;

/** Срок исполнителя: после возврата на доработку — срок доработки, иначе — срок задачи. */
export const personalDeadlineSql = (t = 't') => `COALESCE(${t}.fix_deadline_at, ${t}.deadline_at)`;

/** Личная просрочка исполнителя (п. 8). `now` — выражение времени (по умолчанию now()). */
export const personalOverdueSql = (t = 't', now = 'now()') =>
  `(${assigneeOwesSql(t)} AND ${personalDeadlineSql(t)} IS NOT NULL AND ${personalDeadlineSql(t)} < ${now})`;

/** Просрочка ЗАДАЧИ (проекта) — как была: открыта и срок прошёл. */
export const taskOverdueSql = (t = 't', now = 'now()') =>
  `(${t}.closed_at IS NULL AND ${t}.deadline_at IS NOT NULL AND ${t}.deadline_at < ${now})`;

// ── правила в памяти ──

const NAMES: [Stage, string[]][] = [
  ['done', ['done', 'готово', 'выполнено', 'завершено', 'завершён', 'завершен', 'закрыто', 'сделано']],
  ['testing', ['на тестировании', 'тестирование', 'testing', 'qa', 'тест', 'test']],
  ['review', ['на проверке', 'проверка', 'ревью', 'review', 'in review', 'code review', 'на ревью']],
  ['approval', ['на согласовании', 'согласование', 'на приёмке', 'на приемке', 'приёмка', 'приемка', 'approval', 'waiting approval']],
  ['waiting_external', ['ждём клиента', 'ждем клиента', 'у клиента', 'ожидает клиента', 'waiting client', 'waiting for client', 'на стороне клиента']],
];

/** Тип этапа по названию колонки — тот же набор, что `column_stage_by_name()` в базе. */
export function stageOfColumnName(name: string): Stage {
  const n = String(name ?? '').trim().toLowerCase();
  for (const [stage, list] of NAMES) if (list.includes(n)) return stage;
  // по частям слова (0181): «На тесте», «Тестируется», «QA / тест», «Согласование у заказчика»…
  if (/(жд[её]м|ожида).*(клиент|заказчик)|(клиент|заказчик).*(жд[её]т|ожида)|waiting.*(client|customer)/.test(n)) return 'waiting_external';
  if (/(соглас|при[её]мк|утвержд|approv|accept)/.test(n)) return 'approval';
  if (/(тест|test|(^|[^a-z])qa([^a-z]|$)|qc([^a-z]|$))/.test(n)) return 'testing';
  if (/(провер|ревью|review|ревю)/.test(n)) return 'review';
  if (/(^|\s)(готов|done|выполнен|завершен|завершён|закрыт|сделан)/.test(n) && !/(к работе|к выполн|to do)/.test(n)) return 'done';
  return 'work';
}

export function taskStage(i: { columnStage: Stage | string | null; approvalState?: string | null; closedAt?: Date | string | null }): Stage {
  if (i.closedAt) return 'done';
  if (i.approvalState === 'pending') return 'approval';
  return (STAGES as string[]).includes(String(i.columnStage)) ? (i.columnStage as Stage) : 'work';
}

export const isPaused = (s: Stage) => PAUSED_STAGES.includes(s);

export type ResponsibleType = 'assignee' | 'reviewer' | 'approver' | 'client' | 'none';

/**
 * Кто держит задачу сейчас (п. 6). Проверка и согласование — постановщик (он и
 * принимает работу, решение 12.10); ждём клиента — клиент; в работе — исполнитель.
 */
export function responsibleOf(i: { stage: Stage; assigneeId: string | null; creatorId: string | null }): { type: ResponsibleType; userId: string | null } {
  switch (i.stage) {
    case 'work': return { type: 'assignee', userId: i.assigneeId };
    case 'testing':
    case 'review': return { type: 'reviewer', userId: i.creatorId };
    case 'approval': return { type: 'approver', userId: i.creatorId };
    case 'waiting_external': return { type: 'client', userId: null };
    default: return { type: 'none', userId: null };
  }
}

/** Личная просрочка исполнителя сейчас (п. 8, 12). */
export function personalOverdue(i: { stage: Stage; deadline: Date | string | null; fixDeadline?: Date | string | null; now: Date }): boolean {
  if (i.stage !== 'work') return false;
  const d = i.fixDeadline ?? i.deadline;
  return !!d && new Date(d).getTime() < i.now.getTime();
}

/**
 * На сколько опоздал сам исполнитель (п. 9–10): только до момента сдачи. Время на
 * проверке ему не начисляется. Не сдавал и не закрыто — до сейчас.
 */
export function assigneeDelaySeconds(i: { deadline: Date | string | null; firstSubmittedAt?: Date | string | null; closedAt?: Date | string | null; now: Date }): number {
  if (!i.deadline) return 0;
  const end = i.firstSubmittedAt ?? i.closedAt ?? i.now;
  const stop = Math.min(new Date(end).getTime(), i.now.getTime());
  return Math.max(0, Math.round((stop - new Date(i.deadline).getTime()) / 1000));
}

export const STAGE_LABEL: Record<Stage, string> = {
  work: 'в работе',
  testing: 'на тестировании',
  review: 'на проверке',
  approval: 'на согласовании',
  waiting_external: 'ждёт клиента',
  done: 'готово',
};
