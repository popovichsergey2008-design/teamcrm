/**
 * Приёмка работы: чего не хватает, чтобы задачу можно было сдавать.
 *
 * Чистая функция без базы — правило приёмки должно читаться целиком в одном месте
 * и проверяться тестами, а не собираться по кускам из SQL и условий в сервисе.
 *
 * Гейт МЯГКИЙ: он возвращает список нехваток, а решение «всё равно сдать» остаётся
 * за человеком (обход пишется в историю задачи). Жёсткий запрет здесь был бы вреден:
 * у половины задач результат живёт не в файле — созвон, встреча, переговоры.
 */

export interface GateRequirements {
  /** Все пункты чек-листа отмечены (если чек-лист вообще есть). */
  checklist: boolean;
  /** Исполнитель написал, что сделал. */
  comment: boolean;
  /** К задаче приложен результат. */
  attachment: boolean;
}

export interface GateFacts {
  checklistTotal: number;
  checklistDone: number;
  /** Комментарии ИМЕННО исполнителя: чужие вопросы в карточке отчётом не считаются. */
  ownComments: number;
  attachments: number;
}

export type GateMissCode = 'checklist' | 'comment' | 'attachment';

export interface GateMiss {
  code: GateMissCode;
  /** Готовая строка для человека: диалог показывает её как есть. */
  text: string;
  /**
   * Эту нехватку обойти нельзя: постановщик не принимает задачу без выполненного
   * чек-листа (задача #1386). Остальные — мягкие, как и раньше.
   */
  blocking?: boolean;
}

export const DEFAULT_GATE: GateRequirements = { checklist: true, comment: true, attachment: true };

/**
 * `strictChecklist` — в задаче включено «не принимать без выполненного чек-листа»
 * (по умолчанию включено). Тогда неотмеченный чек-лист — не совет, а запрет: сдать
 * задачу нельзя, пока пункты не отмечены, даже если компания мягкую проверку выключила.
 */
export function handoffGate(req: GateRequirements, facts: GateFacts, strictChecklist = false): GateMiss[] {
  const missing: GateMiss[] = [];

  // Чек-листа нет — и требовать нечего: пустой список не признак недоделанной работы.
  if ((req.checklist || strictChecklist) && facts.checklistTotal > 0 && facts.checklistDone < facts.checklistTotal) {
    const left = facts.checklistTotal - facts.checklistDone;
    missing.push({
      code: 'checklist',
      text: `Не отмечено пунктов чек-листа: ${left} из ${facts.checklistTotal}`,
      ...(strictChecklist ? { blocking: true } : {}),
    });
  }
  if (req.comment && facts.ownComments === 0) {
    missing.push({ code: 'comment', text: 'Нет комментария о том, что сделано' });
  }
  if (req.attachment && facts.attachments === 0) {
    missing.push({ code: 'attachment', text: 'Не приложен результат работы (файл)' });
  }
  return missing;
}
