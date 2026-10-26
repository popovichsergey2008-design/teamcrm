import { request, type ClientContact } from './api';

/**
 * Инфоцентр проекта (#4659): типы и запросы — отдельным модулем.
 *
 * Его импортируют только ленивые куски components/hub/*: в lib/api.ts они легли бы
 * на первый экран, а бюджет веса там исчерпан (scripts/bundle-budget.mjs).
 */
/** Контракт — private/specs/tz39-01. */
export type HubSection = 'passport' | 'team' | 'knowledge';
export type HubKind = 'link' | 'file' | 'contact' | 'note';
export interface HubContact { name?: string | null; role?: string | null; phone?: string | null; email?: string | null; telegram?: string | null }
export interface HubOrigin { type: 'chat_message' | 'meeting' | 'task' | 'comment' | string; id: string; chatId?: string | null; projectId?: string | null }
export interface HubItem {
  id: string; section: HubSection; kind: HubKind; category: string | null; title: string;
  url: string | null; fileId: string | null; fileName: string | null; body: string | null; contact: HubContact | null;
  pinned: boolean; source: 'manual' | 'ai'; origin: HubOrigin | null; createdAt: string;
  createdBy: { id: string; name: string } | null;
}
export interface HubItemInput {
  section: HubSection; kind: HubKind; category?: string | null; title: string;
  url?: string | null; fileId?: string | null; body?: string | null; contact?: HubContact | null;
}
export interface HubMember { userId: string; name: string; avatarUrl: string | null; roleTitle: string | null; responsibility: string | null; isOwner: boolean }
export interface HubPerson { id: string; name: string; avatarUrl?: string | null }
export interface HubDecision {
  id: string; text: string; decidedAt: string; source: 'meeting' | 'chat'; meetingId: string | null; chatId: string | null;
  sourceSec: number | null; speaker: string | null; link: string | null;
}
export interface HubAdded { links: number; files: number; contacts: number; notes: number; decisions: number }
export interface HubRun { id: string; runDate: string; finishedAt: string | null; added: HubAdded; usedModel: boolean; status?: string; error?: string | null }
export interface HubView {
  project: {
    id: string; name: string; mission: string | null; audience: string | null; description: string | null; aliases: string[];
    targetDate: string | null; clientId: string | null; clientName: string | null; hubLibrarian: boolean;
  };
  passport: HubItem[]; knowledge: HubItem[];
  team: { owner: HubPerson | null; members: HubMember[]; contacts: HubItem[]; clientContacts: ClientContact[] };
  decisions: { items: HubDecision[]; total: number };
  librarian: { lastRun: HubRun | null; unseen: HubRun | null };
  canEdit: boolean;
}


export const hubApi = {
  view: (id: string) => request<HubView>('GET', `/projects/${id}/hub`),
  passport: (id: string, b: { mission?: string; audience?: string; description?: string; hubLibrarian?: boolean }) =>
    request<unknown>('PATCH', `/projects/${id}/hub/passport`, b),
  addItem: (id: string, b: HubItemInput) => request<HubItem>('POST', `/projects/${id}/hub/items`, b),
  updateItem: (id: string, itemId: string, b: Partial<HubItemInput> & { pinned?: boolean }) =>
    request<HubItem>('PATCH', `/projects/${id}/hub/items/${itemId}`, b),
  removeItem: (id: string, itemId: string) => request<unknown>('DELETE', `/projects/${id}/hub/items/${itemId}`),
  member: (id: string, userId: string, b: { roleTitle?: string; responsibility?: string }) =>
    request<unknown>('PATCH', `/projects/${id}/hub/members/${userId}`, b),
  decisions: (id: string, before?: string, limit = 20) =>
    request<{ items: HubDecision[]; total: number }>('GET', `/projects/${id}/hub/decisions?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}`),
  run: (id: string, runId: string) =>
    request<{ run: HubRun; items: (HubItem & { removed?: boolean })[]; decisions: HubDecision[] }>('GET', `/projects/${id}/hub/runs/${runId}`),
  seen: (id: string, runId: string) => request<unknown>('POST', `/projects/${id}/hub/runs/${runId}/seen`),
  collect: (id: string) => request<{ run: HubRun; status: string }>('POST', `/projects/${id}/hub/librarian/run`),
  ask: (id: string, q: string) =>
    request<{ answer: string; citations: { title: string | null; link?: string | null; sourceType: string }[]; cached: boolean }>('POST', `/projects/${id}/hub/ask`, { q }),
};
