import { request } from '../../lib/api';

/** #4902, п. 15: ручки чата с клиентом — в ленивом куске, `api` первого экрана не утяжеляют. */
export interface ClientLink { id: string; label: string | null; expiresAt: string; createdAt: string; author: string | null; guests: number; lastUsedAt: string | null; canRevoke: boolean }
export interface ClientTask { id: string; projectId: string; title: string; status: string; statusLabel: string; deadline: string | null; overdue: boolean }
export interface ClientOverview { links: ClientLink[]; tasks: ClientTask[]; summary: string }
export interface Candidate { id: string; title: string; project: string | null; statusLabel: string; done: boolean }
export interface Suggestion { text: string; summary: string; done: number; total: number; deadline: string | null; scope: 'opened' | 'project' | 'none'; source: 'ai' | 'rules' }

const c = (id: string) => `/client-chat/chats/${encodeURIComponent(id)}`;

export const clientChatApi = {
  overview: (chatId: string) => request<ClientOverview>('GET', c(chatId)),
  createLink: (chatId: string, b: { label?: string; days?: number }) =>
    request<{ id: string; url: string; expiresAt: string; label: string | null }>('POST', `${c(chatId)}/links`, b),
  revokeLink: (id: string) => request<{ revoked: boolean; kicked: number }>('DELETE', `/client-chat/links/${encodeURIComponent(id)}`),
  candidates: (chatId: string, q: string) => request<Candidate[]>('GET', `${c(chatId)}/candidates${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  openTask: (chatId: string, taskId: string) => request<{ opened: boolean }>('POST', `${c(chatId)}/tasks`, { taskId }),
  closeTask: (chatId: string, taskId: string) => request<{ closed: boolean }>('DELETE', `${c(chatId)}/tasks/${encodeURIComponent(taskId)}`),
  suggest: (chatId: string) => request<Suggestion>('POST', `${c(chatId)}/suggest`, {}),
};
