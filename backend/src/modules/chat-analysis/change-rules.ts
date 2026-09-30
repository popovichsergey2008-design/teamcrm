import { resolveTask, TaskSource } from './journal-rules';

/**
 * Финальное состояние разговора (ТЗ-12, разд. 30–32).
 *
 * Задачу завели, а позже в том же чате её отменили, отдали другому или перенесли срок.
 * Правило ТЗ жёсткое: уже созданную задачу агент молча НЕ трогает. Он замечает изменение
 * и спрашивает постановщика — тот отвечает «да» или «оставить», и только тогда задача
 * меняется, его руками и с его правами.
 *
 * Задачу, о которой речь, берём по основаниям, и они здесь строже, чем у статуса:
 *   * пересланная карточка или названный «#номер» — уверенность 1;
 *   * выбор модели — только среди задач, РОДИВШИХСЯ В ЭТОМ ЧАТЕ: «не делай» в том же
 *     разговоре, где поручили, относится к тому поручению, а не к чьей-то задаче вообще.
 *
 * Чистые функции; проверяются юнит-тестом рядом.
 */

export const CHANGE_KINDS = ['cancel', 'reassign', 'deadline'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** Ниже этой уверенности в самом изменении постановщика не беспокоим. */
export const CHANGE_MIN_INTENT = 0.9;

/** К какой уже заведённой задаче относится изменение. */
export function resolveChangeTarget(o: {
  sources: TaskSource[];
  alive: Set<string>;
  modelTaskId: string | null;
  /** Открытые задачи, заведённые из сообщений этого чата. */
  bornHere: Set<string>;
}): { taskId: string | null; confidence: number } {
  const named = resolveTask({ sources: o.sources, alive: o.alive, modelTaskId: null, owners: new Map() });
  if (named.taskId) return { taskId: named.taskId, confidence: 1 };
  // Названо несколько задач — resolveTask промолчал; догадке модели тут тем более не место.
  const many = o.sources.some((s) => /#\s?\d/.test(s.text)) || o.sources.some((s) => s.sharedTaskId);
  if (many) return { taskId: null, confidence: 0 };
  if (o.modelTaskId && o.bornHere.has(String(o.modelTaskId))) return { taskId: String(o.modelTaskId), confidence: 0.9 };
  return { taskId: null, confidence: 0 };
}

/**
 * Состояние наблюдения об изменении.
 *
 * `noop` — менять нечего (исполнитель и так Глеб, срок и так понедельник): такое
 * наблюдение не записываем вовсе, иначе постановщику придёт вопрос ни о чём.
 */
export function changeReadiness(o: {
  kind: string | null;
  intent: number;
  taskId: string | null;
  newAssigneeId: string | null;
  newDeadline: Date | null;
  current: { assigneeId: string | null; deadline: Date | null } | null;
}): 'ready' | 'detected' | 'noop' {
  if (!o.kind || !CHANGE_KINDS.includes(o.kind as ChangeKind)) return 'detected';
  if (o.intent < CHANGE_MIN_INTENT || !o.taskId || !o.current) return 'detected';
  if (o.kind === 'reassign') {
    if (!o.newAssigneeId) return 'detected';
    return String(o.newAssigneeId) === String(o.current.assigneeId ?? '') ? 'noop' : 'ready';
  }
  if (o.kind === 'deadline') {
    if (!o.newDeadline) return 'detected';
    const same = o.current.deadline && Math.abs(o.current.deadline.getTime() - o.newDeadline.getTime()) < 60_000;
    return same ? 'noop' : 'ready';
  }
  return 'ready';
}

/**
 * Новый исполнитель — только названный в сообщениях об изменении или вызвавшийся сам
 * («давайте я возьму»). Догадка модели по профилю — не изменение, а выдумка.
 */
export function newAssigneeOf(o: { modelAssigneeId: string | null; named: string[]; authors: (string | null)[] }): string | null {
  const c = o.modelAssigneeId ? String(o.modelAssigneeId) : null;
  if (!c) return null;
  return o.named.includes(c) || o.authors.some((a) => a && String(a) === c) ? c : null;
}

/**
 * Решать об изменении вправе постановщик задачи или владелец — те же права, что у
 * решения о переносе срока в самих задачах.
 */
export function canApplyChange(o: { userId: string; role: string; creatorId: string | null }): boolean {
  return o.role === 'owner' || (!!o.creatorId && String(o.creatorId) === String(o.userId));
}

/** Ответ постановщика на вопрос бота. Непонятный ответ — не ответ. */
export function parseYesNo(text: string): 'yes' | 'no' | null {
  const t = String(text ?? '').toLowerCase().replace(/ё/g, 'е').trim();
  const no = /(^|[^а-я])(нет|оставь|оставить|оставляем|не надо|не нужно|не отменяй|не меняй|не переноси)([^а-я]|$)/.test(t);
  // «не отменяй» — это «нет», а не «да» со словом «отменяй» внутри.
  const positive = t.replace(/(^|[^а-я])не\s+[а-я]+/g, ' ');
  const yes = /(^|[^а-я])(да|давай|давайте|ок|окей|угу|ага|конечно|подтверждаю|отменяй|отмени|переназначь|перенеси|меняй)([^а-я]|$)/.test(positive);
  if (yes === no) return null;
  return yes ? 'yes' : 'no';
}

/** Что именно предлагается — словами, одинаково в вопросе и в панели. */
export function changeSummary(o: { kind: ChangeKind; assigneeName: string | null; deadlineLabel: string | null }): string {
  if (o.kind === 'cancel') return 'похоже, поручение отменили';
  if (o.kind === 'reassign') return `похоже, исполнителем теперь будет ${o.assigneeName ?? 'другой человек'}`;
  return `похоже, срок перенесли на ${o.deadlineLabel ?? 'другую дату'}`;
}

export function changeAskText(o: {
  who: string | null; kind: ChangeKind; taskId: string; title: string;
  assigneeName: string | null; deadlineLabel: string | null;
}): string {
  const question = o.kind === 'cancel' ? 'Отменить задачу?' : o.kind === 'reassign' ? 'Переназначить?' : 'Перенести срок?';
  return [
    `${o.who ? `${o.who}, ` : ''}по задаче #${o.taskId} «${o.title}» ${changeSummary(o)}. ${question}`,
    'Ответьте «да» или «оставить». Сам я задачу не трогаю.',
  ].join('\n');
}

export function changeDoneText(o: { kind: ChangeKind; taskId: string; title: string; assigneeName: string | null; deadlineLabel: string | null }): string {
  if (o.kind === 'cancel') return `Готово: задача #${o.taskId} «${o.title}» отменена и убрана в корзину.`;
  if (o.kind === 'reassign') return `Готово: задача #${o.taskId} «${o.title}» теперь у ${o.assigneeName ?? 'нового исполнителя'}.`;
  return `Готово: срок задачи #${o.taskId} «${o.title}» — ${o.deadlineLabel ?? 'новый'}.`;
}

/**
 * Отмена, названная прямым текстом, — правилом, а не моделью.
 *
 * Живая проверка 30.09: на одиночную реплику «по #1473 отбой — клиент передумал,
 * выгрузку не делаем» модель не вернула ничего. Номер задачи и слово отмены — это не
 * тонкость смысла, которую надо понимать; это видно по тексту. Страховка находит такие
 * реплики и без модели. Решает всё равно постановщик: бот только спросит.
 *
 * Берём реплику человека, где назван РОВНО один живой номер и есть явное слово отмены.
 * Отрицание («не отменяем», «отбой не нужен») отсекается.
 */
const CANCEL_WORDS = /(^|[^а-я])(отбой|отменяем|отменяется|отменить|отмена|не делаем|не делай|не надо делать|клиент передумал|передумали|снимаем)([^а-я]|$)/;
const CANCEL_DENIED = /(^|[^а-я])(не отменя|отбой не|не снимаем)/;

export function ruleCancellations(
  messages: { id: string; body: string; isAi: boolean }[],
  alive: Set<string>,
  numbersIn: (text: string) => string[],
): { messageId: string; taskId: string }[] {
  const out: { messageId: string; taskId: string }[] = [];
  for (const m of messages) {
    if (m.isAi) continue;
    const text = String(m.body ?? '').toLowerCase().replace(/ё/g, 'е');
    if (!CANCEL_WORDS.test(text) || CANCEL_DENIED.test(text)) continue;
    const ids = numbersIn(text).filter((id) => alive.has(id));
    if (ids.length !== 1) continue;
    out.push({ messageId: String(m.id), taskId: ids[0] });
  }
  return out;
}
