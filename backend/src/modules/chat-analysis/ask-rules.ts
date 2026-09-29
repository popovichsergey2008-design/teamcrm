/**
 * Когда и о чём спрашивать в чате (ТЗ-12, разд. 17–18).
 *
 * Вопрос в рабочем чате — самое заметное, что делает агент: его видят все участники.
 * Поэтому спрашиваем редко и по делу:
 *   * только про поручение и только когда в том, ЧТО это поручение, сомнений нет —
 *     иначе получится «а не задача ли это?», и на такой вопрос никто не отвечает;
 *   * только один раз про одно наблюдение: молчание — тоже ответ;
 *   * не ночью и не в выходной: вопрос в три часа ночи работу не ускорит;
 *   * не больше одного вопроса за проход, даже если непонятных поручений несколько, —
 *     три подряд сообщения бота выглядят как поломка.
 *
 * Чистые функции; проверяются юнит-тестом рядом.
 */

/** Так `missingParts` называет отмену в разговоре. */
const CANCELLED = 'в разговоре есть отмена';

/** Ниже этого в «это поручение» агент сам не уверен — спрашивать не о чем. */
export const ASK_MIN_INTENT = 0.9;

export function shouldAsk(o: {
  type: string;
  status: string;
  intentConfidence: number;
  /** Уже спрашивали про это наблюдение. */
  asked: boolean;
  /** Чего не хватает: пусто — спрашивать нечего. */
  missing: string[];
  /** Рабочее время организации. */
  working: boolean;
  /** Владелец выключил вопросы в чатах. */
  enabled: boolean;
}): boolean {
  if (!o.enabled || !o.working || o.asked) return false;
  if (o.type !== 'task' || o.status !== 'needs_clarification') return false;
  if (o.intentConfidence < ASK_MIN_INTENT) return false;
  // Поручение отменили в том же разговоре — спрашивать «к какому проекту?» о нём нелепо.
  if (o.missing.includes(CANCELLED)) return false;
  // Спрашиваем только о том, что человек может назвать одним словом.
  return o.missing.some((m) => m === 'проект' || m === 'исполнитель');
}

/**
 * Текст вопроса.
 *
 * Одним сообщением и об обоих полях сразу: два вопроса подряд о одном поручении
 * читаются как придирка. Пример ответа обязателен — без него отвечают «да».
 */
export function askText(o: {
  who: string | null;
  title: string;
  needProject: boolean;
  needAssignee: boolean;
  projectNames: string[];
}): string {
  const parts: string[] = [];
  if (o.needProject && o.needAssignee) parts.push('к какому проекту это относится и кто это сделает');
  else if (o.needProject) parts.push('к какому проекту это относится');
  else parts.push('кто это сделает');

  const hint = o.needProject && o.projectNames.length
    ? ` Например: «${o.projectNames.slice(0, 3).join('», «')}»${o.needAssignee ? ', Пётр' : ''}.`
    : '';

  return [
    `${o.who ? `${o.who}, ` : ''}по поручению «${o.title}» — ${parts[0]}?`,
    `Ответьте одним сообщением.${hint}`,
    'Спрошу один раз: если сейчас не до этого, просто не отвечайте.',
  ].join('\n');
}

/** Подтверждение: что именно приняли из ответа. */
export function acceptedText(o: {
  title: string;
  projectName: string | null;
  assigneeName: string | null;
  ready: boolean;
}): string {
  const got = [
    o.projectName ? `проект «${o.projectName}»` : null,
    o.assigneeName ? `исполнитель ${o.assigneeName}` : null,
  ].filter(Boolean).join(', ');

  return o.ready
    ? `Принял: ${got}. Поручение «${o.title}» готово — осталось завести задачу.`
    : `Принял: ${got}. Поручению «${o.title}» всё ещё чего-то не хватает — дооформлю в разборе переписки.`;
}
