/**
 * «Входящие» (#4807 §6): что из ящика уведомлений куда попадает и как склеивается.
 *
 * Чистые функции — без базы: ими пользуются и выборка, и тесты.
 */

/** Тип строки — от него значок, быстрые действия и вкладка (таблица 6.2). */
export type InboxKind = 'decision' | 'mention' | 'assigned' | 'ai' | 'meeting' | 'comment' | 'change' | 'system';

export const INBOX_TABS = ['important', 'ai', 'all', 'snoozed', 'done'] as const;
export type InboxTab = (typeof INBOX_TABS)[number];

/** Каждое сообщение чата во «Входящие» не попадает — у него свой раздел (6.2, «Не попадает»). */
export const NOT_IN_INBOX = ['chat.message'];

const KIND_BY_KEY: Record<string, InboxKind> = {
  'task.approval': 'decision',
  'task.shift_asked': 'decision',
  'task.mention': 'mention',
  'chat.mention': 'mention',
  'task.created': 'assigned',
  'task.assignee': 'assigned',
  'task.deadline': 'assigned',
  'task.returned': 'assigned',
  'task.shift_decided': 'assigned',
  'assistant.proposal': 'ai',
  'task.auto_confirm': 'ai',
  'task.followup': 'ai',
  'task.commented': 'comment',
  'task.status': 'change',
  'task.closed': 'change',
  'task.participant': 'change',
  'task.priority': 'change',
  'task.manager': 'change',
};

export function inboxKind(eventKey: string): InboxKind {
  if (KIND_BY_KEY[eventKey]) return KIND_BY_KEY[eventKey];
  if (eventKey.startsWith('meeting.') || eventKey.startsWith('call.')) return 'meeting';
  return 'system';
}

/** Ключи событий типа — для SQL-фильтра вкладки. */
export function keysOfKinds(kinds: InboxKind[]): string[] {
  return Object.entries(KIND_BY_KEY).filter(([, k]) => kinds.includes(k)).map(([key]) => key);
}

/** «Важное»: решения, упоминания, назначенное мне, созвоны. */
export const IMPORTANT_KINDS: InboxKind[] = ['decision', 'mention', 'assigned', 'meeting'];

export interface InboxRowLite {
  id: string;
  event_key: string;
  title: string;
  body: string;
  path: string | null;
  created_at: Date;
  read_at: Date | null;
  done_at?: Date | null;
  snoozed_until?: Date | null;
  task_id: string | null;
  task_title: string | null;
  project_id: string | null;
  actor_name: string | null;
  details: Record<string, unknown> | null;
}

export interface InboxGroup {
  /** Номер первой (свежей) строки — ключ в списке. */
  id: string;
  /** Все строки группы: прочитать / готово / отложить — сразу все. */
  ids: string[];
  kind: InboxKind;
  eventKey: string;
  title: string;
  body: string;
  path: string | null;
  createdAt: Date;
  unread: boolean;
  count: number;
  actors: string[];
  task: { id: string; title: string; projectId: string | null } | null;
  details: Record<string, unknown> | null;
  snoozedUntil: Date | null;
  doneAt: Date | null;
}

/** Склеиваем только «шумные» типы: ответы в обсуждениях и изменения задач (6.3). */
const GROUPED: InboxKind[] = ['comment', 'change'];
const DAY_MS = 24 * 3600_000;

/**
 * События об одном объекте за 24 часа — одна строка: «5 новых комментариев к #1220 ·
 * Сергей, Анна». Строки приходят свежими сверху; группа держится, пока разница с
 * первой строкой меньше суток.
 */
export function groupInbox(rows: InboxRowLite[]): InboxGroup[] {
  const out: InboxGroup[] = [];
  const open = new Map<string, InboxGroup>();
  for (const r of rows) {
    const kind = inboxKind(r.event_key);
    const key = GROUPED.includes(kind) && r.task_id ? `${kind}:${r.task_id}` : null;
    const g = key ? open.get(key) : undefined;
    if (g && g.createdAt.getTime() - new Date(r.created_at).getTime() < DAY_MS) {
      g.ids.push(r.id);
      g.count += 1;
      g.unread ||= !r.read_at;
      if (r.actor_name && !g.actors.includes(r.actor_name)) g.actors.push(r.actor_name);
      g.title = groupTitle(kind, g.count, g.task?.id ?? null, g.title);
      continue;
    }
    const item: InboxGroup = {
      id: r.id, ids: [r.id], kind, eventKey: r.event_key, title: r.title, body: r.body, path: r.path,
      createdAt: new Date(r.created_at), unread: !r.read_at, count: 1,
      actors: r.actor_name ? [r.actor_name] : [],
      task: r.task_id ? { id: r.task_id, title: r.task_title ?? '', projectId: r.project_id } : null,
      details: r.details, snoozedUntil: r.snoozed_until ?? null, doneAt: r.done_at ?? null,
    };
    out.push(item);
    if (key) open.set(key, item);
  }
  return out;
}

function groupTitle(kind: InboxKind, n: number, taskId: string | null, fallback: string): string {
  const to = taskId ? ` к #${taskId}` : '';
  if (kind === 'comment') return `${n} ${plural(n, 'новый комментарий', 'новых комментария', 'новых комментариев')}${to}`;
  if (kind === 'change') return `${n} ${plural(n, 'изменение', 'изменения', 'изменений')} в задаче${taskId ? ` #${taskId}` : ''}`;
  return fallback;
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10; const m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
}

/** «Отложить до» — только будущее и не дальше года: иначе это «Готово». */
export function validSnooze(until: Date, now = new Date()): boolean {
  const t = until.getTime();
  return Number.isFinite(t) && t > now.getTime() && t - now.getTime() <= 366 * DAY_MS;
}
