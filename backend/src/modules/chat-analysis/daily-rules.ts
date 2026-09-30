/**
 * Суточная сверка и качество разбора (ТЗ-12, разд. 3.3, 19, 27–29, 58–60).
 *
 * Разбор по затиханию видит разговор кусками. Ночью агент ещё раз проходит весь день
 * целиком: так видны связи между кусками. Но то, что уже разобрано, заново не пишется —
 * иначе у каждого поручения за день было бы по два наблюдения, а у постановщика — по два
 * вопроса. «Уже разобрано» узнаём по сообщениям-источникам, а не по тексту: модель на
 * второй раз сформулирует то же самое иначе.
 *
 * Чистые функции; проверяются юнит-тестом рядом.
 */

/** Версия наших правил разбора: пишется в каждый проход рядом с моделью и промптом. */
export const RULES_VERSION = '2026-09-30.1';

/** Сколько сообщений за раз уходит модели: больше — она теряет начало (как в отрезках). */
export const DAILY_CHUNK = 120;

/** Роли источников, по которым наблюдение узнаётся. «Контекст» общий у многих — не в счёт. */
const KEY_ROLES = new Set(['instruction', 'acceptance', 'correction', 'cancellation', 'decision']);

/** Ключевые сообщения наблюдения. Нет ни одного — узнаём по всем источникам. */
export function keyMessages(sources: { messageId: string; role: string }[]): string[] {
  const key = sources.filter((s) => KEY_ROLES.has(s.role)).map((s) => s.messageId);
  return key.length ? key : sources.map((s) => s.messageId);
}

/**
 * Уже разобрано ли (разд. 29): есть наблюдение того же вида, у которого совпадает хотя
 * бы одно ключевое сообщение. Поручение и изменение этого поручения — разные виды, и
 * друг друга не глушат.
 */
export function alreadyCovered(
  a: { type: string; keys: string[] },
  existing: { type: string; messageIds: string[] }[],
): boolean {
  const mine = new Set(a.keys);
  return existing.some((e) => e.type === a.type && e.messageIds.some((id) => mine.has(id)));
}

/** День переписки — кусками по порядку: модель читает кусок целиком. */
export function chunks<T>(items: T[], size = DAILY_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Цифры дня по организации (разд. 27). */
export interface DayStats {
  messages: number;
  sourceMessages: number;
  tasksCreated: number;
  meetings: number;
  decisions: number;
  notes: number;
  waiting: number;
  clarifications: number;
  chats: { title: string; created: string[]; waiting: string[] }[];
}

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

/**
 * Сводка владельцу. Короткая — строкой ассистента (там предел 300 знаков), полная — в
 * Telegram. Пустой день — без сводки: сообщение «ничего не произошло» учит не читать.
 */
export function dailyDigest(s: DayStats): { short: string; long: string } | null {
  if (!s.messages) return null;
  const made = [
    s.tasksCreated ? `${s.tasksCreated} ${plural(s.tasksCreated, 'задача', 'задачи', 'задач')}` : null,
    s.meetings ? `${s.meetings} ${plural(s.meetings, 'встреча', 'встречи', 'встреч')}` : null,
    s.decisions ? `${s.decisions} ${plural(s.decisions, 'решение', 'решения', 'решений')}` : null,
    s.notes ? `${s.notes} ${plural(s.notes, 'отметка', 'отметки', 'отметок')} в задачах` : null,
  ].filter(Boolean);
  const ignored = Math.max(0, s.messages - s.sourceMessages);
  const head = 'Итоги переписки за день';
  const lines = [
    made.length ? `Заведено: ${made.join(', ')}.` : 'Новых задач и решений из переписки нет.',
    s.waiting || s.clarifications
      ? `Ждут вашего решения: ${s.waiting}, не хватает данных: ${s.clarifications}.`
      : null,
    `Обычная переписка без поручений: ${ignored} ${plural(ignored, 'сообщение', 'сообщения', 'сообщений')}.`,
  ].filter(Boolean) as string[];

  const short = `${head}. ${lines.join(' ')}`.slice(0, 290);
  const byChat = s.chats
    .filter((c) => c.created.length || c.waiting.length)
    .map((c) => [
      `• ${c.title}`,
      ...c.created.map((x) => `  ✓ ${x}`),
      ...c.waiting.map((x) => `  ⚠ ${x}`),
    ].join('\n'));
  const long = [head, ...lines, ...(byChat.length ? ['', ...byChat] : []), '', 'Подробно — «Настройки → Разбор переписки».']
    .join('\n');
  return { short, long };
}

// ── качество ──

/** Причины «ИИ ошибся» (разд. 59): короткий список, иначе их не посчитать. */
export const FEEDBACK_REASONS = ['not_action', 'wrong_assigner', 'wrong_assignee', 'wrong_project', 'wrong_deadline', 'wrong_text'] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];

/** Оставляем только известные причины и без повторов; «верно» причин не имеет. */
export function cleanReasons(correct: boolean, reasons: unknown): FeedbackReason[] {
  if (correct || !Array.isArray(reasons)) return [];
  return [...new Set(reasons.map(String))].filter((r): r is FeedbackReason => (FEEDBACK_REASONS as readonly string[]).includes(r));
}

/** Доля или пусто, когда делить не на что: «0 из 0» — не ноль процентов. */
export const rate = (part: number, whole: number): number | null => (whole > 0 ? Math.min(1, part / whole) : null);
