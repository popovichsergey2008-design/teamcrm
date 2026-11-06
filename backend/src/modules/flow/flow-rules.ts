/**
 * Чистые правила доски (#4798 / #4799): без базы, чтобы их можно было проверить тестом.
 */

/** Почему работа стоит — пять причин из ТЗ (4798 §8). */
export const BLOCKER_REASONS = ['wait_answer', 'no_access', 'no_info', 'depends', 'other'] as const;
export type BlockerReason = (typeof BLOCKER_REASONS)[number];

export const BLOCKER_LABEL: Record<BlockerReason, string> = {
  wait_answer: 'Жду ответ',
  no_access: 'Нет доступа',
  no_info: 'Не хватает информации',
  depends: 'Зависит от другой задачи',
  other: 'Другая причина',
};

/** Этапы, на которых работа сдана и ждёт решения (ТЗ-30). */
export const REVIEW_STAGES = ['testing', 'review', 'approval'] as const;

/**
 * Появится ли цикл, если задача `taskId` начнёт ждать `dependsOn`.
 *
 * `edges` — уже существующие связи «задача → от чего зависит». Цикл есть, если от
 * `dependsOn` по связям можно дойти до `taskId`.
 */
export function wouldCycle(edges: { task_id: string; depends_on_id: string }[], taskId: string, dependsOn: string): boolean {
  if (String(taskId) === String(dependsOn)) return true;
  const next = new Map<string, string[]>();
  for (const e of edges) {
    const k = String(e.task_id);
    next.set(k, [...(next.get(k) ?? []), String(e.depends_on_id)]);
  }
  const seen = new Set<string>();
  const stack = [String(dependsOn)];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === String(taskId)) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(next.get(cur) ?? []));
  }
  return false;
}

/** События, на которые можно повесить правило (4798 §18, 4799 BOARD10). */
export const RULE_TRIGGERS = ['handed_to_review', 'returned', 'deadline_soon', 'dependency_done', 'accepted'] as const;
export type RuleTrigger = (typeof RULE_TRIGGERS)[number];
/** Действия — только сообщить: автоархив, автозакрытие и перенос намеренно не предусмотрены. */
export const RULE_ACTIONS = ['notify_reviewer', 'notify_creator', 'notify_assignee', 'notify_watchers', 'notify_dependents'] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];

export const TRIGGER_TEXT: Record<RuleTrigger, string> = {
  handed_to_review: 'задача передана на проверку',
  returned: 'задача возвращена на доработку',
  deadline_soon: 'до срока остаётся меньше суток',
  dependency_done: 'завершена задача, от которой зависят другие',
  accepted: 'результат принят',
};
export const ACTION_TEXT: Record<RuleAction, string> = {
  notify_reviewer: 'уведомить проверяющего',
  notify_creator: 'уведомить постановщика',
  notify_assignee: 'уведомить исполнителя',
  notify_watchers: 'уведомить наблюдателей',
  notify_dependents: 'сообщить исполнителям зависимых задач, что можно продолжать',
};

/** Правило обычной фразой: «Когда задача передана на проверку, тогда уведомить постановщика». */
export function ruleSentence(trigger: RuleTrigger, action: RuleAction): string {
  return `Когда ${TRIGGER_TEXT[trigger]}, тогда ${ACTION_TEXT[action]}`;
}

/** Готовые правила, с которых предлагаем начать (4798 §18). */
export const RULE_PRESETS: { trigger: RuleTrigger; action: RuleAction }[] = [
  { trigger: 'handed_to_review', action: 'notify_reviewer' },
  { trigger: 'returned', action: 'notify_assignee' },
  { trigger: 'deadline_soon', action: 'notify_assignee' },
  { trigger: 'dependency_done', action: 'notify_dependents' },
  { trigger: 'accepted', action: 'notify_watchers' },
];

/**
 * Рабочие дни между двумя моментами (без субботы и воскресенья) — для «В работе 3 дня».
 * Считаем полные сутки: задача, пролежавшая с пятницы вечера до понедельника утра,
 * стоит меньше одного рабочего дня.
 */
export function workDaysBetween(from: Date, to: Date): number {
  if (!(from instanceof Date) || Number.isNaN(from.getTime()) || to <= from) return 0;
  let days = 0;
  const d = new Date(from);
  while (true) {
    d.setDate(d.getDate() + 1);
    if (d > to) break;
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) days++;
  }
  return days;
}
