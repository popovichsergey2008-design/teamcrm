/**
 * Правила уборки: что считать брошенным и как об этом сказать.
 *
 * Вынесено чистыми функциями, потому что цена ошибки здесь выше, чем везде в ассистенте:
 * напоминание можно проигнорировать, а закрытую задачу человек может просто не заметить.
 * Пороги и формулировки должны читаться в одном месте и проверяться тестами.
 */

export type MaintenanceKind = 'task_stale' | 'project_idle' | 'draft_stale';

export interface Thresholds {
  /** Сколько дней задача стоит без единого движения, прежде чем о ней спросят. */
  taskDays: number;
  /** Сколько дней в проекте ничего не происходит при полностью закрытых задачах. */
  projectDays: number;
  /** Сколько дней черновик со встречи ждёт подтверждения. */
  draftDays: number;
}

/**
 * Пороги нарочно большие.
 *
 * Два месяца без движения — это не «забыли на неделе», это работа, о которой никто
 * не вспомнил ни разу за два месяца. Меньший порог превратил бы уборщика в того, кто
 * лезет под руку.
 */
export const DEFAULT_THRESHOLDS: Thresholds = { taskDays: 60, projectDays: 30, draftDays: 30 };

export interface Candidate {
  kind: MaintenanceKind;
  subjectId: string;
  title: string;
  /** Сколько дней объект не двигался. */
  days: number;
  /** Для задачи — проект, для черновика — встреча: без этого человеку непонятно, о чём речь. */
  context: string | null;
}

/** «62 дня» / «2 месяца»: месяцами понятнее, но врать округлением тоже нельзя. */
export function daysWord(days: number): string {
  const d = Math.max(1, Math.round(days));
  const tail = d % 10;
  const teen = d % 100 >= 11 && d % 100 <= 14;
  const word = !teen && tail === 1 ? 'день' : !teen && tail >= 2 && tail <= 4 ? 'дня' : 'дней';
  return `${d} ${word}`;
}

/**
 * Что говорим человеку.
 *
 * Формулировка — предложение, а не приговор: «предлагаю закрыть» и всегда с причиной.
 * Уборщик, который сообщает о результате вместо намерения, пугает, а пугающий ассистент
 * заканчивается выключенным ассистентом.
 */
export function proposalText(c: Candidate): string {
  const where = c.context ? ` (${c.context})` : '';
  switch (c.kind) {
    case 'task_stale':
      return `Задача не двигалась ${daysWord(c.days)} — предлагаю закрыть: «${c.title}»${where}`;
    case 'project_idle':
      return `Все задачи закрыты, ${daysWord(c.days)} тишины — предлагаю сдать проект в архив: «${c.title}»`;
    case 'draft_stale':
      return `Черновик со встречи ждёт решения ${daysWord(c.days)} — предлагаю отклонить: «${c.title}»${where}`;
  }
}

/** Один объект — один вопрос: человек ответил, и второй раз мы не спрашиваем. */
export function dedupKey(c: Candidate): string {
  return `${c.kind}:${c.subjectId}`;
}

/** Что и куда возвращать при откате. Пусто — откат невозможен, такое не предлагаем. */
export function undoOf(c: Candidate, before: Record<string, unknown>): Record<string, unknown> {
  return { kind: c.kind, subjectId: c.subjectId, ...before };
}

/**
 * Сколько предложений показываем за раз.
 *
 * Список из сорока пунктов не разбирают — его закрывают. Лучше десять сейчас
 * и ещё десять на следующей неделе.
 */
export const MAX_PROPOSALS_PER_RUN = 10;

export function limitCandidates(candidates: Candidate[]): Candidate[] {
  // сначала самое старое: чем дольше лежит, тем безопаснее убирать
  return [...candidates].sort((a, b) => b.days - a.days).slice(0, MAX_PROPOSALS_PER_RUN);
}
