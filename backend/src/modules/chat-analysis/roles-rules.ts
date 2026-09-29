import { SourceRole } from './analysis-schema';

/**
 * Кто поручил и кому — по самому разговору (ТЗ-12, разд. 10–11, 14).
 *
 * Это самое опасное место функции. Задача с неверным постановщиком выглядит как
 * поручение, которого человек не давал, и разбирать это приходится людям. Поэтому роли
 * определяем НЕ по тому, что сказала модель, а по тому, КТО НАПИСАЛ сообщение, которое
 * она пометила поручением. Модель здесь отвечает на вопрос «где здесь поручение», а на
 * вопрос «чьё оно» отвечает сама переписка.
 *
 * Разбираем только три однозначных образца из ТЗ. Всё остальное — «непонятно», и это
 * рабочий ответ: спросить дешевле, чем назначить не того.
 *
 * Чистые функции; проверяются юнит-тестом рядом.
 */

/** Порог, ниже которого поручение не считается понятым (ТЗ, разд. 14). */
export const THRESHOLDS = { intent: 0.9, project: 0.9, assigner: 0.95, assignee: 0.9 };

/** Сообщение-источник вместе с тем, кто его написал. */
export interface SourceAuthor {
  messageId: string;
  role: SourceRole;
  /** У сообщения бота автора нет. */
  authorId: string | null;
}

/**
 * Какой образец узнали:
 *   accepted — «Нужно переделать» → «Ок, беру»: исполнитель тот, кто согласился;
 *   named    — «Юра, исправь API»: исполнитель назван в самом поручении;
 *   self     — «я завтра подготовлю отчёт»: поручение самому себе;
 *   unknown  — ни один не подошёл, исполнителя не выдумываем.
 */
export type RolePattern = 'accepted' | 'named' | 'self' | 'unknown';

export interface Roles {
  assignerId: string | null;
  assigneeId: string | null;
  assignerConfidence: number;
  assigneeConfidence: number;
  pattern: RolePattern;
  /** В разговоре есть отмена: поручение так и не стало поручением. */
  cancelled: boolean;
}

/**
 * Роли из разговора.
 *
 * `modelAssigneeId` — исполнитель, которого назвала модель, УЖЕ сверенный со
 * справочником участников. Его берём только когда своего ответа у переписки нет:
 * прямое «Юра, исправь» модель разбирает лучше правил, а вот «кто здесь начальник»
 * определяется авторством, и спорить тут не с чем.
 */
export function resolveRoles(o: {
  sources: SourceAuthor[];
  modelAssigneeId: string | null;
}): Roles {
  const cancelled = o.sources.some((s) => s.role === 'cancellation');
  const instruction = o.sources.find((s) => s.role === 'instruction' && s.authorId) ?? null;

  // Поручения в переписке не нашлось — значит, и постановщика нет.
  if (!instruction?.authorId) {
    return {
      assignerId: null, assigneeId: null,
      assignerConfidence: 0, assigneeConfidence: 0,
      pattern: 'unknown', cancelled,
    };
  }
  const assignerId = String(instruction.authorId);

  // «Ок, беру» — сильнее любого имени: человек сам взял работу.
  const accepted = o.sources.find(
    (s) => s.role === 'acceptance' && s.authorId && String(s.authorId) !== assignerId,
  );
  if (accepted?.authorId) {
    return {
      assignerId, assigneeId: String(accepted.authorId),
      assignerConfidence: 0.95, assigneeConfidence: 0.95,
      pattern: 'accepted', cancelled,
    };
  }

  const named = o.modelAssigneeId ? String(o.modelAssigneeId) : null;
  if (named) {
    return {
      assignerId, assigneeId: named,
      assignerConfidence: 0.95, assigneeConfidence: 0.9,
      // Поручил сам себе — это законный образец, а не ошибка разбора.
      pattern: named === assignerId ? 'self' : 'named', cancelled,
    };
  }

  // Поручение есть, исполнителя нет. Угадывать по навыкам не будем: в режиме
  // «только предлагать» выигрыша от догадки нет, а выглядит она как решение.
  return {
    assignerId, assigneeId: null,
    assignerConfidence: 0.95, assigneeConfidence: 0,
    pattern: 'unknown', cancelled,
  };
}

/**
 * Готово ли поручение к тому, чтобы стать задачей.
 *
 * `ready` — значит, человеку остаётся нажать «завести»: понятно что, в каком проекте,
 * от кого и кому. Всё остальное — `needs_clarification`: чего-то не хватает, и на
 * третьем этапе бот об этом спросит прямо в чате.
 *
 * Отменённое поручение готовым не бывает, даже если поля заполнены: последнее слово в
 * разговоре было «не делай».
 */
export function taskReadiness(a: {
  projectId: string | null;
  assigneeId: string | null;
  assignerId: string | null;
  cancelled: boolean;
  confidence: { intent: number; project: number; assigner: number; assignee: number };
}): 'ready' | 'needs_clarification' {
  if (a.cancelled) return 'needs_clarification';
  if (!a.projectId || !a.assigneeId || !a.assignerId) return 'needs_clarification';
  const c = a.confidence;
  const ok = c.intent >= THRESHOLDS.intent
    && c.project >= THRESHOLDS.project
    && c.assigner >= THRESHOLDS.assigner
    && c.assignee >= THRESHOLDS.assignee;
  return ok ? 'ready' : 'needs_clarification';
}

/** Чего именно не хватает — словами, которые попадут в вопрос человеку. */
export function missingParts(a: {
  projectId: string | null;
  assigneeId: string | null;
  assignerId: string | null;
  cancelled: boolean;
}): string[] {
  const out: string[] = [];
  if (a.cancelled) out.push('в разговоре есть отмена');
  if (!a.projectId) out.push('проект');
  if (!a.assigneeId) out.push('исполнитель');
  if (!a.assignerId) out.push('постановщик');
  return out;
}
