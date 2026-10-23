/**
 * Центр уведомлений (#4655): кто узнаёт о событии по задаче и какими словами.
 *
 * Отдельным файлом без базы и без Nest: именно здесь легко ошибиться — разбудить
 * автора его же действием или забыть наблюдателя, — и именно это проверяется без
 * сервера. Сервис только достаёт участников и пишет строки.
 */

import { guessGender } from '../../common/text/ru-grammar';

/** События по задаче, которые ложатся в историю. */
export type TaskEventKind =
  | 'created' | 'participant' | 'assignee' | 'manager' | 'deadline' | 'priority' | 'status' | 'closed'
  | 'comment' | 'mention' | 'approval' | 'returned' | 'shift_asked' | 'shift_decided'
  | 'blocked' | 'deadline_soon' | 'overdue' | 'merged';

/**
 * Ключ события в ящике. Создание и комментарий — прежние ключи писем: на них уже
 * смотрят телефон и тесты ящика; остальное — свои, чтобы центр различал их значком.
 */
export const TASK_EVENT_KEY: Record<TaskEventKind, string> = {
  created: 'task.created',
  participant: 'task.participant',
  assignee: 'task.assignee',
  manager: 'task.manager',
  deadline: 'task.deadline',
  priority: 'task.priority',
  status: 'task.status',
  closed: 'task.closed',
  comment: 'task.commented',
  mention: 'task.mention',
  approval: 'task.approval',
  returned: 'task.returned',
  shift_asked: 'task.shift_asked',
  shift_decided: 'task.shift_decided',
  blocked: 'task.blocked',
  deadline_soon: 'task.deadline_soon',
  overdue: 'task.overdue',
  merged: 'task.merged',
};

/** Люди задачи: от них считаем, кому сказать. */
export interface TaskPeople {
  assigneeId: string | null;
  /** Постановщик. */
  creatorId: string | null;
  coAssignees: string[];
  watchers: string[];
}

/**
 * Кем человек приходится событию. От этого зависят слова: исполнителю «назначил вас»,
 * остальным — «сменил исполнителя».
 */
export type RecipientRole = 'assignee' | 'creator' | 'co_assignee' | 'watcher' | 'target' | 'previous';

export interface CenterRecipient { userId: string; role: RecipientRole }

export interface RecipientOpts {
  /** Адресаты по смыслу события: кого добавили, упомянули, на кого переназначили. */
  targets?: string[];
  /** Прежний исполнитель — его с задачи сняли, и он уже не в списке участников. */
  previous?: string | null;
  /** Кого не звать этим событием: упомянутые получают «упомянул», а не «комментарий». */
  except?: string[];
}

/**
 * Кому событие — без автора действия.
 *
 * Своё действие новостью не является: поставил задачу, сдвинул срок, написал
 * комментарий — и получил об этом уведомление. У системных событий (срок подошёл)
 * автора нет, поэтому `actorId = null` никого не отсеивает.
 *
 * Порядок важен: первая роль человека — та, по которой он получит слова. Исполнитель,
 * он же наблюдатель, получает «назначил вас», а не «сменил исполнителя».
 */
export function taskRecipients(
  kind: TaskEventKind, people: TaskPeople, actorId: string | null, opts: RecipientOpts = {},
): CenterRecipient[] {
  const list: CenterRecipient[] = [];
  const add = (id: string | null | undefined, role: RecipientRole) => { if (id) list.push({ userId: String(id), role }); };
  const assignee = () => add(people.assigneeId, 'assignee');
  const creator = () => add(people.creatorId, 'creator');
  const co = () => people.coAssignees.forEach((id) => add(id, 'co_assignee'));
  const watchers = () => people.watchers.forEach((id) => add(id, 'watcher'));
  const targets = () => (opts.targets ?? []).forEach((id) => add(id, 'target'));
  const everyone = () => { assignee(); creator(); co(); watchers(); };

  switch (kind) {
    // соисполнителей и наблюдателей новой задачи зовёт «добавил вас» — дважды не надо
    case 'created': assignee(); creator(); break;
    case 'participant': case 'manager': case 'mention': case 'merged': targets(); break;
    case 'assignee': targets(); add(opts.previous, 'previous'); everyone(); break;
    case 'shift_decided': targets(); everyone(); break;
    // сдал работу, просит срок, упёрся — это вопрос к постановщику; наблюдатели в курсе
    case 'approval': case 'shift_asked': case 'blocked': creator(); watchers(); break;
    // вернули — делать исполнителям
    case 'returned': assignee(); co(); break;
    case 'deadline_soon':
      assignee(); co();
      // некому делать — значит, это забота постановщика
      if (!people.assigneeId && !people.coAssignees.length) creator();
      break;
    case 'overdue': assignee(); co(); creator(); break;
    default: everyone();
  }

  const except = new Set((opts.except ?? []).map(String));
  const seen = new Set<string>();
  return list.filter((r) => {
    if (seen.has(r.userId)) return false;
    seen.add(r.userId);
    if (actorId && r.userId === String(actorId)) return false;
    return !except.has(r.userId);
  });
}

/** Подробности события — то, что центр показывает строками под заголовком. */
export interface TaskEventDetails {
  /** Новый статус (название колонки). */
  status?: string | null;
  priority?: string | null;
  /** Срок задачи: ISO или null — «срок снят». */
  deadline?: string | null;
  /** Срок, на который просят перенести / перенесли. */
  shiftTo?: string | null;
  approved?: boolean;
  comment?: string | null;
  reason?: string | null;
  /** Роль, в которую добавили (соисполнитель / наблюдатель). */
  participantRole?: 'co_assignee' | 'watcher';
  /** Номер задачи, которую влили в эту. */
  mergedFrom?: string | null;
}

/**
 * Действие словами — то, что стоит между именем автора и задачей:
 * «Ольга | назначил вас исполнителем задачи | [#12] Обновить прайс».
 *
 * Пола в профиле нет: по имени автора угадываем, и «Валентина Игоревна» получает
 * «добавила». Не угадали — мужской род, как в письмах: «назначил(а)» читается хуже.
 * У системных событий автора нет — фраза тогда начинает строку сама.
 */
export function taskEventPhrase(kind: TaskEventKind, role: RecipientRole, d: TaskEventDetails = {}, actorName?: string | null): string {
  const phrase = basePhrase(kind, role, d);
  return guessGender(actorName) === 'f' ? phrase.replace(/^(\S+л)(?=\s)/u, '$1а') : phrase;
}

function basePhrase(kind: TaskEventKind, role: RecipientRole, d: TaskEventDetails): string {
  switch (kind) {
    case 'created': return role === 'creator' ? 'назначил вас постановщиком задачи' : 'поставил вам задачу';
    case 'participant':
      return d.participantRole === 'co_assignee' ? 'добавил вас соисполнителем в задачу' : 'добавил вас наблюдателем в задачу';
    case 'assignee':
      return role === 'target' ? 'назначил вас исполнителем задачи'
        : role === 'previous' ? 'передал другому исполнителю задачу' : 'сменил исполнителя задачи';
    case 'manager': return 'назначил вас постановщиком задачи';
    case 'deadline': return d.deadline ? 'изменил срок задачи' : 'снял срок задачи';
    case 'priority': return 'изменил приоритет задачи';
    case 'status': return 'сменил статус задачи';
    case 'closed': return 'завершил задачу';
    case 'comment': return 'оставил комментарий к задаче';
    case 'mention': return 'упомянул вас в задаче';
    case 'approval': return 'сдал на проверку задачу';
    case 'returned': return 'вернул на доработку задачу';
    case 'shift_asked': return 'просит перенести срок задачи';
    case 'shift_decided': return d.approved ? 'согласовал перенос срока задачи' : 'отклонил перенос срока задачи';
    case 'blocked': return 'сообщил о блокере в задаче';
    case 'deadline_soon': return 'Скоро срок по задаче';
    case 'overdue': return 'Просрочена задача';
    case 'merged': return d.mergedFrom ? `объединил задачу #${d.mergedFrom} с задачей` : 'объединил задачи в';
  }
}

/** Приоритет словами: в базе он кодом. */
const PRIORITY: Record<string, string> = { low: 'низкий', normal: 'обычный', high: 'высокий', urgent: 'срочно' };
export function priorityLabel(p: string | null | undefined): string {
  if (!p) return 'без приоритета';
  return PRIORITY[p] ?? p;
}

/**
 * Заголовок и текст записи для телефона и всплывашки — одной строкой, без разметки.
 * Центр рисует строку сам из подробностей, а push и старый ящик читают именно это.
 */
export function taskEventText(
  kind: TaskEventKind, role: RecipientRole, actorName: string | null, taskTitle: string, d: TaskEventDetails = {},
): { title: string; body: string } {
  const phrase = taskEventPhrase(kind, role, d, actorName);
  const title = actorName ? `${actorName} ${phrase}: ${taskTitle}` : `${phrase}: ${taskTitle}`;
  const body = d.comment || d.reason
    || (d.status ? `Статус: ${d.status}` : '')
    || (kind === 'priority' ? `Приоритет: ${priorityLabel(d.priority)}` : '');
  return { title: title.slice(0, 255), body: String(body ?? '').replace(/\s+/g, ' ').trim().slice(0, 500) };
}

/**
 * Кого упомянули в обсуждении задачи: «@Иван Петров» — так поле с упоминаниями
 * вставляет имя. Ищем полные имена сотрудников, длинные раньше коротких, чтобы
 * «@Иван Петров» не нашёлся заодно как «@Иван». Сравнение без регистра; после имени
 * — конец строки, пробел или знак препинания, а не продолжение слова.
 */
export function mentionedUsers(text: string, users: { id: string; full_name: string }[]): string[] {
  if (!text || !text.includes('@')) return [];
  const lower = text.toLowerCase();
  const found = new Set<string>();
  const sorted = [...users].filter((u) => u.full_name?.trim()).sort((a, b) => b.full_name.length - a.full_name.length);
  const taken: [number, number][] = [];
  for (const u of sorted) {
    const needle = `@${u.full_name.trim().toLowerCase()}`;
    let at = lower.indexOf(needle);
    while (at >= 0) {
      const end = at + needle.length;
      const next = lower.charAt(end);
      // буква или цифра после имени — это другое, более длинное имя
      const boundary = !next || !/[\p{L}\p{N}_]/u.test(next);
      if (boundary && !taken.some(([s, e]) => at >= s && at < e)) {
        found.add(String(u.id));
        taken.push([at, end]);
        break;
      }
      at = lower.indexOf(needle, at + 1);
    }
  }
  return [...found];
}

/** Ключ строки центра — тот же, что у письма об этом событии (см. NotificationsService). */
export function centerKey(mailEventKey: string, taskId: string, userId: string, suffix: string): string {
  return `${mailEventKey}:${taskId}:${userId}:${suffix}`.slice(0, 160);
}
