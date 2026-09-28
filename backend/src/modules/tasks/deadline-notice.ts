/**
 * Что и когда сказать про срок задачи.
 *
 * Отдельным файлом без базы и без Nest: это единственная часть предупреждений, где
 * легко ошибиться на сутки, и единственная, которую можно проверить без сервера.
 */

/**
 * За сколько до срока предупреждаем. Сутки: столько же даёт Битрикс, и этого хватает,
 * чтобы успеть либо доделать, либо честно попросить перенос.
 */
export const SOON_MS = 24 * 60 * 60 * 1000;

export type NoticeKind = 'soon' | 'overdue';

export interface NoticeInput {
  deadlineAt: Date;
  /** Задача закрыта — про срок молчим, даже если он прошёл. */
  closed: boolean;
  /** Про какие сроки этой задачи уже говорили: те же вид и срок повторять нельзя. */
  said: NoticeKind[];
  now: Date;
}

/**
 * Пора ли что-то сказать и что именно.
 *
 * Порядок проверок и есть смысл: сначала «уже просрочена», потом «скоро». Если
 * планировщик стоял (ночь, перезапуск, выкладка) и оба мига прошли, сказать надо
 * ГЛАВНОЕ — что задача просрочена, а не что она вот-вот просрочится.
 *
 * Пропущенное «почти просрочена» при этом не досылаем: предупреждение задним числом
 * бесполезно и только засоряет обсуждение.
 */
export function noticeDue(input: NoticeInput): NoticeKind | null {
  if (input.closed) return null;
  const left = input.deadlineAt.getTime() - input.now.getTime();

  if (left <= 0) return input.said.includes('overdue') ? null : 'overdue';
  if (left <= SOON_MS) return input.said.includes('soon') ? null : 'soon';
  return null;
}

/**
 * Текст предупреждения.
 *
 * Обращаемся по имени исполнителя: в задаче на пятерых «задача почти просрочена» без
 * имени читается как «кто-нибудь, посмотрите», то есть никто. Исполнителя нет — так и
 * пишем: это и есть главная причина, по которой срок сорвётся.
 */
export function noticeText(kind: NoticeKind, assignee: string | null, deadlineHuman: string): string {
  if (kind === 'soon') {
    return assignee
      ? `${assignee}, задача почти просрочена. Крайний срок задачи ${deadlineHuman}`
      : `Задача почти просрочена, крайний срок ${deadlineHuman}, а исполнитель не назначен`;
  }
  return assignee
    ? `${assignee}, задача просрочена ${deadlineHuman}. Завершите её как можно скорее или измените крайний срок`
    : `Задача просрочена ${deadlineHuman}, а исполнитель так и не назначен. Назначьте исполнителя или измените крайний срок`;
}

/**
 * Срок по-человечески: «21 сентября 2026, 15:00».
 *
 * В часовом поясе организации, а не сервера: «15:00» обязано значить то же, что и в
 * карточке задачи, иначе предупреждение спорит с тем, что человек видит рядом.
 */
export function humanDeadline(at: Date, tz: string): string {
  const date = at.toLocaleDateString('ru-RU', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: tz,
  });
  const time = at.toLocaleTimeString('ru-RU', {
    hour: '2-digit', minute: '2-digit', timeZone: tz,
  });
  // toLocaleDateString с годом добавляет « г.» — в тексте оно лишнее.
  return `${date.replace(/\s*г\.$/, '')}, ${time}`;
}
