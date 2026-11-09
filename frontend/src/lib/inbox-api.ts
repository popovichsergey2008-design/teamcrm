/**
 * «Входящие» (#4807 §6): клиент API. Отдельным модулем — им пользуются ленивая
 * страница и счётчик в меню, а не первый экран целиком.
 */
import { request } from './api';

export type InboxKind = 'decision' | 'mention' | 'assigned' | 'ai' | 'meeting' | 'comment' | 'change' | 'system';
export type InboxTab = 'important' | 'ai' | 'all' | 'snoozed' | 'done';

export interface InboxItem {
  id: string;
  /** Все строки склеенной группы: действие применяется ко всем. */
  ids: string[];
  kind: InboxKind;
  eventKey: string;
  title: string;
  body: string;
  path: string | null;
  createdAt: string;
  unread: boolean;
  count: number;
  actors: string[];
  task: { id: string; title: string; projectId: string | null } | null;
  details: Record<string, unknown> | null;
  snoozedUntil: string | null;
  doneAt: string | null;
}

export interface InboxCounters {
  important: number; mentions: number; assigned: number; decisions: number; meetings: number; ai: number;
}

/** Событие окна: «Входящие» поменялись — счётчик в меню перечитывается. */
export const INBOX_CHANGED = 'qevo:inbox-changed';

export type InboxMode = 'push' | 'inbox' | 'off';
export interface InboxPref { kind: InboxKind; title: string; mode: InboxMode; locked: boolean }

export const inboxApi = {
  prefs: () => request<InboxPref[]>('GET', '/inbox/prefs'),
  setPref: (kind: InboxKind, mode: InboxMode) => request<InboxPref[]>('PUT', '/inbox/prefs', { kind, mode }),
  list: (tab: InboxTab, cursor?: string | null) =>
    request<{ items: InboxItem[]; next: string | null }>('GET', `/inbox?tab=${tab}${cursor ? `&cursor=${cursor}` : ''}`),
  counters: () => request<InboxCounters>('GET', '/inbox/counters'),
  bulk: (ids: string[], action: 'read' | 'unread' | 'done' | 'snooze', until?: string) =>
    request<{ changed: number; counters: InboxCounters }>('POST', '/inbox/bulk', { ids, action, ...(until ? { until } : {}) }),
  undone: (id: string) => request<{ changed: number; counters: InboxCounters }>('POST', `/inbox/${id}/undone`),
  /** Открыл задачу — её строки во «Входящих» прочитаны (не «Готово»). */
  readTask: (taskId: string) => request<{ changed: number }>('POST', '/inbox/read-task', { taskId }),
};

/** «Отложить»: через час, завтра 9:00, в понедельник 9:00 — по часам человека. */
export function snoozeTime(preset: 'hour' | 'tomorrow' | 'monday', now = new Date()): Date {
  if (preset === 'hour') return new Date(now.getTime() + 3600_000);
  const d = new Date(now);
  d.setHours(9, 0, 0, 0);
  if (preset === 'tomorrow') d.setDate(d.getDate() + 1);
  else d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7));
  return d;
}

/*
  Тип события — как на сервере (notifications/inbox-rules.ts): по нему всплывашка решает,
  показываться ли (режим «Только входящие» / «Не показывать» — тихо).
*/
const KIND_BY_KEY: Record<string, InboxKind> = {
  'task.approval': 'decision', 'task.shift_asked': 'decision',
  'task.mention': 'mention', 'chat.mention': 'mention',
  'task.created': 'assigned', 'task.assignee': 'assigned', 'task.deadline': 'assigned', 'task.returned': 'assigned', 'task.shift_decided': 'assigned',
  'assistant.proposal': 'ai', 'task.auto_confirm': 'ai', 'task.followup': 'ai',
  'task.commented': 'comment',
  'task.status': 'change', 'task.closed': 'change', 'task.participant': 'change', 'task.priority': 'change', 'task.manager': 'change',
};
export function inboxKindOf(eventKey: string): InboxKind {
  return KIND_BY_KEY[eventKey] ?? (eventKey.startsWith('meeting.') || eventKey.startsWith('call.') ? 'meeting' : 'system');
}

let modes: Map<InboxKind, InboxMode> | null = null;
/** Запомнить режимы (после загрузки или сохранения настроек). */
export function setInboxModes(list: InboxPref[]): void {
  modes = new Map(list.map((p) => [p.kind, p.mode]));
}
/** Режимы человека — один запрос на сессию; до ответа считаем «Входящие и push». */
export function loadInboxModes(): void {
  if (modes) return;
  modes = new Map();
  void inboxApi.prefs().then(setInboxModes).catch(() => { modes = null; });
}
/** Можно ли о событии всплывашкой и звуком: сообщения чатов — не тип «Входящих». */
export function inboxToastAllowed(eventKey: string): boolean {
  if (eventKey === 'chat.message') return true;
  const m = modes?.get(inboxKindOf(eventKey));
  return !m || m === 'push';
}
