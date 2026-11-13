/** «Ждут вашего решения» и разбор по одной карточке (#4890, пп. 3–6) — ленивый кусок «Фокуса дня». */
import { request } from '../../lib/api';
import type { Passport } from '../pulse/pulse-api';

export interface DecisionCard {
  key: string; kind: 'review' | 'approval'; taskId: string | null; approvalId: string | null; title: string;
  projectId: string | null; projectName: string | null; assigneeId: string | null; assigneeName: string | null;
  submittedAt: string; deadlineAt: string | null; waitingDays: number; nextStepMe: boolean;
}
export interface DecisionResult {
  actionId: string; action: DecisionAction; text: string; notified: string | null;
  count: { before: number; after: number }; index: { before: number; after: number } | null; stays: boolean;
}
export type DecisionAction = 'accept' | 'return' | 'ask' | 'close';
export interface RunSummary {
  decisions: number; asked: number; accepted: number; returned: number; closed: number; minutes: number;
  index: { before: number; after: number } | null; unblocked: string[]; left: number;
}
export interface DecisionListItem {
  key: string; kind: 'review' | 'approval'; taskId: string | null; approvalId: string | null; title: string; projectId: string | null;
  projectName: string | null; assigneeName: string | null; submittedAt: string; deadlineAt: string | null; waitingDays: number;
}

export const decisionsApi = {
  count: () => request<{ count: number; updatedAt: string }>('GET', '/decisions/count'),
  passport: () => request<Passport>('GET', '/decisions/passport'),
  list: () => request<{ count: number; overdue: number; updatedAt: string; items: DecisionListItem[] }>('GET', '/decisions/list'),
  batch: (exclude: string[]) => request<{ count: number; etaMin: number; index: number | null; items: DecisionCard[] }>('GET', `/decisions/batch?exclude=${encodeURIComponent(exclude.join(','))}`),
  recap: (taskId: string) => request<{ text: string; source: 'ai' | 'rules' }>('GET', `/decisions/recap/${taskId}`),
  decide: (b: { key: string; action: DecisionAction; note?: string | null; runId?: string | null }) => request<DecisionResult>('POST', '/decisions/decide', b),
  undo: (actionId: string) => request<{ undone: boolean; count: number; index: { before: number; after: number } | null }>('POST', `/decisions/actions/${actionId}/undo`, {}),
  summary: (runId: string, startedAt: string) => request<RunSummary>('POST', '/decisions/summary', { runId, startedAt }),
};
