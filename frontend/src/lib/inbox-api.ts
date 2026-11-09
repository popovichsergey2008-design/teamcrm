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

export const inboxApi = {
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
