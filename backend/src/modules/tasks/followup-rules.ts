/**
 * Догоняющий вопрос по задаче: когда спрашивать и что делать с ответом (ТЗ-11, разд. 50).
 *
 * Чистые функции без базы. Это та часть, где ошибка выглядит не как поломка, а как
 * «система пристаёт с вопросами» — и лечится тем, что ассистента выключают целиком.
 *
 * ГЛАВНОЕ ПРАВИЛО — СПРОСИТЬ ОДИН РАЗ ПРО ОДИН СРОК. Не «напомнить ещё разок», не
 * «уточнить на всякий случай»: один вопрос на срок. Перенесли срок — спросим про
 * новый, ответили — больше не тронем.
 */

/** За сколько до срока спрашиваем: окно, а не точка. */
export const ASK_FROM_MS = 6 * 60 * 60 * 1000;
export const ASK_TO_MS = 4 * 60 * 60 * 1000;

export type FollowupAnswer = 'on_track' | 'blocked' | 'need_shift';

export interface AskInput {
  deadlineAt: Date;
  now: Date;
  closed: boolean;
  /** Сдана и ждёт приёмки: работа уже сделана, спрашивать «как идёт» поздно и глупо. */
  waitingApproval: boolean;
  /** Исполнителя нет — спрашивать некого. */
  hasAssignee: boolean;
  /** Про этот срок уже спрашивали. */
  asked: boolean;
  /** Сейчас рабочее время у ИСПОЛНИТЕЛЯ (считает вызывающий по его поясу). */
  working: boolean;
}

/**
 * Пора ли спросить.
 *
 * Окно 4–6 часов до срока — из ТЗ, и оно осмысленно: раньше ответ «успеваю» ничего не
 * значит, позже поздно что-либо делать. Если в это окно у человека ночь или выходной,
 * не спрашиваем вовсе: вопрос в три часа ночи не ускорит работу, а доверие потратит.
 *
 * Вне окна молчим и потом: догоняющий вопрос, заданный за час до срока, — это уже не
 * вопрос, а укор.
 */
export function shouldAsk(input: AskInput): boolean {
  if (input.closed || input.waitingApproval || !input.hasAssignee || input.asked) return false;
  if (!input.working) return false;
  const left = input.deadlineAt.getTime() - input.now.getTime();
  return left <= ASK_FROM_MS && left > ASK_TO_MS;
}

/** Текст вопроса: коротко, с названием задачи и сроком — по ним и принимают решение. */
export function askText(title: string, deadlineHuman: string): string {
  const short = title.length > 90 ? `${title.slice(0, 89)}…` : title;
  return `Как идёт работа по задаче «${short}»? Срок ${deadlineHuman}`;
}

/**
 * Что значит ответ.
 *
 * Возвращаем не текст, а решения: их выполняет сервис, и каждое должно быть видно
 * снаружи. «Успеваю» намеренно не делает ничего, кроме записи ответа, — это и есть
 * обещание no-nagging: человек ответил, и его оставили в покое.
 */
export function effectsOf(answer: FollowupAnswer): {
  markBlocked: boolean;
  askShift: boolean;
  notifyManager: boolean;
} {
  return {
    markBlocked: answer === 'blocked',
    askShift: answer === 'need_shift',
    // Постановщик узнаёт и про блокер, и про просьбу о переносе: это единственные два
    // ответа, после которых что-то должен сделать он, а не исполнитель.
    notifyManager: answer !== 'on_track',
  };
}

/**
 * Куда двигать срок по просьбе «нужен перенос».
 *
 * Дату предлагает исполнитель, но в разумных пределах: назад — бессмысленно, на год
 * вперёд — это не перенос, а отмена. Не прислали дату вовсе — сутки: самый частый
 * случай «не успеваю сегодня, доделаю завтра».
 */
export function shiftTarget(requested: Date | null, deadlineAt: Date, now: Date): Date {
  const min = Math.max(deadlineAt.getTime(), now.getTime());
  const max = now.getTime() + 365 * 24 * 60 * 60 * 1000;
  const wanted = requested?.getTime();
  if (!wanted || Number.isNaN(wanted) || wanted <= min) return new Date(min + 24 * 60 * 60 * 1000);
  return new Date(Math.min(wanted, max));
}
