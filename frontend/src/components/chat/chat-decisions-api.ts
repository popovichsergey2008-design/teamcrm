/**
 * #4902, п. 9: запросы вкладки «Решения» — отдельным файлом в ленивом куске, первый
 * экран о них не знает. Пункт меню сообщения «Отметить как решение» тянет его по требованию.
 */
import { ApiError, request } from '../../lib/api';
import { showToast, toastSaved } from '../../lib/notifications';

export type DecisionSource =
  | { kind: 'message'; messageId: string | null; chatId: string | null }
  | { kind: 'meeting'; meetingId: string; title: string | null; sec: number | null };

export interface Decision {
  id: string; text: string; decidedAt: string; who: string | null; source: DecisionSource;
  task: { id: string; title: string | null; projectId: string | null; status: string | null; closed: boolean } | null;
  done: boolean; doneBy: 'task' | 'manual' | null; doneAt: string | null; doneByName: string | null;
  supersededBy: { id: string; text: string | null } | null; markedBy: string | null;
}
export interface Candidate { id: string; text: string; origin: 'rules' | 'ai'; messageId: string; author: string | null; at: string; body: string }
export interface Question {
  key: string; text: string; author: string | null; at: string;
  source: { kind: 'message'; messageId: string } | { kind: 'meeting'; meetingId: string; title: string };
  state: null | { state: 'poll' | 'call'; pollPostId: string | null; at: string; by: string | null };
}
export interface DecisionsTab {
  chat: { id: string; kind: string; title: string | null; projectId: string | null };
  decisions: Decision[]; candidates: Candidate[]; questions: Question[];
  counts: { decisions: number; open: number; candidates: number; questions: number };
}

/** Событие: журнал решений чата изменился — открытая вкладка перечитывает себя. */
export const DECISIONS_CHANGED = 'qevo:decisions-changed';
const changed = () => window.dispatchEvent(new CustomEvent(DECISIONS_CHANGED));

export const decisionsApi = {
  tab: (chatId: string) => request<DecisionsTab>('GET', `/chat-decisions/chats/${chatId}`),
  suggest: (chatId: string) => request<{ ai: boolean; added: number; note: string }>('POST', `/chat-decisions/chats/${chatId}/suggest`, {}),
  resolve: (chatId: string, body: { key: string; how: 'poll' | 'call' | 'decided' | 'dismissed' | 'reopen'; text?: string; options?: string[] }) =>
    request<{ key: string; state: string | null; pollPostId?: string | null }>('POST', `/chat-decisions/chats/${chatId}/questions`, body),
  mark: (messageId: string, text?: string) => request<{ id: string; created: boolean }>('POST', `/chat-decisions/messages/${messageId}`, text ? { text } : {}),
  candidate: (id: string, accept: boolean, text?: string) => request<unknown>('POST', `/chat-decisions/candidates/${id}`, { accept, ...(text ? { text } : {}) }),
  done: (id: string, done: boolean) => request<unknown>('POST', `/chat-decisions/${id}/done`, { done }),
  task: (id: string, body: { taskId?: string; title?: string }) => request<{ taskId: string }>('POST', `/chat-decisions/${id}/task`, body),
  revoke: (id: string) => request<unknown>('POST', `/chat-decisions/${id}/revoke`, {}),
};

/** Пункт меню сообщения: записать его решением чата. */
export async function markDecision(messageId: string): Promise<void> {
  try {
    const r = await decisionsApi.mark(messageId);
    toastSaved(r.created ? 'Записано в решения чата' : 'Это сообщение уже в решениях', 'Вкладка «Решения» над перепиской');
    changed();
  } catch (e) {
    showToast({ title: 'Не удалось записать решение', body: e instanceof ApiError ? e.message : 'Ошибка', section: 'chat' });
  }
}

export { changed as notifyDecisionsChanged };
