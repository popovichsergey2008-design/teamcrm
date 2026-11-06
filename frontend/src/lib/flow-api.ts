/**
 * Поток работы на доске (#4798 / #4799): препятствия, связи задач, сдача результата,
 * очередь решений, виды, правила, ссылка для клиента. Отдельным модулем — им
 * пользуются доска и ленивые окна, а не первый экран целиком.
 */
import { request } from './api';
import type { Task, TaskBlocker } from '../types';

export interface Handoff {
  id: string; version: number; author_id: string | null; author_name: string | null;
  done_text: string; where_text: string; limits_text: string; reviewer_id: string | null; created_at: string;
  decision: 'accepted' | 'returned' | null; decided_at: string | null; decision_note: string | null;
}
export interface TaskLink { dir: 'waits' | 'blocks'; id: string; title: string; closed: boolean; deadline_at: string | null; project_id: string; assignee_name: string | null }
export interface QueueItem {
  id: string; title: string; project_id: string; project_name: string; column_name: string;
  assignee_name: string | null; creator_name: string | null; deadline_at: string | null; submitted_at: string | null;
  checklist_total: number; checklist_done: number;
  handoff: { version: number; done: string; author: string | null; at: string } | null;
}
export interface ReviewItem {
  task: {
    id: string; title: string; description: string | null; project_id: string; column_id: string;
    deadline_at: string | null; submitted_at: string | null; first_submitted_at: string | null; returned_at: string | null;
    closed_at: string | null; approval_state: string; assignee_name: string | null; creator_name: string | null;
    reviewer_name: string | null; version: number;
  };
  handoffs: Handoff[];
  checklist: { text: string; is_done: boolean }[];
  files: { id: string; name: string; mime: string; created_at: string }[];
  ai: {
    verdict?: string; summary?: string; conclusion?: string; at?: string;
    checked?: { what: string; status: string; evidence: string; how?: string }[];
    missing?: string[]; askHuman?: string[];
  } | null;
  check: { version: number; status: string; summary: Record<string, unknown>; mode: string; finished_at: string | null } | null;
  canDecide: boolean;
}
export interface BoardView { id: string; project_id: string; owner_id: string; owner_name: string | null; name: string; query: Record<string, unknown>; shared: boolean }
export interface BoardRule { id: string; trigger: string; action: string; enabled: boolean; author_name: string | null; created_at: string; runs: number; last_run_at: string | null; sentence: string }
export interface RulesView {
  rules: BoardRule[];
  presets: { trigger: string; action: string; sentence: string }[];
  runs: { id: string; rule_id: string; task_id: string | null; title: string | null; recipients: number; created_at: string }[];
}
export interface ShareLink { id: string; token: string; created_at: string; revoked_at: string | null; decision: string | null; decision_note: string | null; decided_at: string | null; guest_name: string | null }

export const flowApi = {
  blocker: (taskId: string) => request<TaskBlocker | null>('GET', `/tasks/${taskId}/blocker`),
  setBlocker: (taskId: string, b: { reason: string; need: string; helperId?: string | null; nextStep?: string; dueOn?: string | null }) =>
    request<TaskBlocker>('PUT', `/tasks/${taskId}/blocker`, b),
  resolveBlocker: (taskId: string, note?: string) => request<{ ok: true }>('DELETE', `/tasks/${taskId}/blocker`, { note }),

  links: (taskId: string) => request<TaskLink[]>('GET', `/tasks/${taskId}/links`),
  addLink: (taskId: string, dependsOn: string) => request<TaskLink[]>('POST', `/tasks/${taskId}/links`, { dependsOn }),
  removeLink: (taskId: string, dep: string) => request<TaskLink[]>('DELETE', `/tasks/${taskId}/links/${dep}`),

  submit: (taskId: string, b: {
    done?: string; where?: string; limits?: string; reviewerId?: string | null;
    columnId: string; position?: number; confirmGate?: boolean; noAfterReason?: string;
  }) => request<{ task: Task; handoff: Handoff }>('POST', `/tasks/${taskId}/handoff`, b),
  handoffs: (taskId: string) => request<Handoff[]>('GET', `/tasks/${taskId}/handoffs`),
  queue: () => request<QueueItem[]>('GET', '/review/queue'),
  reviewItem: (taskId: string) => request<ReviewItem>('GET', `/review/${taskId}`),
  decide: (taskId: string, b: { action: 'accept' | 'return' | 'ask'; note?: string; handoffVersion?: number }) =>
    request<{ ok: true; action: string; already?: boolean }>('POST', `/review/${taskId}/decision`, b),
  requestUpdate: (taskId: string) => request<{ ok: true; already?: boolean }>('POST', `/tasks/${taskId}/request-update`),

  views: (projectId: string) => request<BoardView[]>('GET', `/projects/${projectId}/views`),
  createView: (projectId: string, b: { name: string; query: Record<string, unknown>; shared?: boolean }) =>
    request<BoardView>('POST', `/projects/${projectId}/views`, b),
  updateView: (id: string, b: { name?: string; query?: Record<string, unknown>; shared?: boolean }) => request<BoardView>('PATCH', `/board-views/${id}`, b),
  deleteView: (id: string) => request<{ ok: true }>('DELETE', `/board-views/${id}`),

  setWip: (projectId: string, limit: number | null) => request<{ wipLimit: number | null }>('PUT', `/projects/${projectId}/wip`, { limit }),

  rules: (projectId: string) => request<RulesView>('GET', `/projects/${projectId}/rules`),
  addRule: (projectId: string, trigger: string, action: string) => request<RulesView>('POST', `/projects/${projectId}/rules`, { trigger, action }),
  previewRule: (projectId: string, trigger: string, action: string) =>
    request<{ sentence: string; examples: { id: string; title: string; recipients: string[] }[] }>('POST', `/projects/${projectId}/rules/preview`, { trigger, action }),
  toggleRule: (projectId: string, id: string, enabled: boolean) => request<RulesView>('PATCH', `/projects/${projectId}/rules/${id}`, { enabled }),
  deleteRule: (projectId: string, id: string) => request<RulesView>('DELETE', `/projects/${projectId}/rules/${id}`),

  shares: (taskId: string) => request<ShareLink[]>('GET', `/tasks/${taskId}/shares`),
  createShare: (taskId: string, b: { summary?: string; result: string; fileIds?: string[] }) =>
    request<{ token: string; path: string }>('POST', `/tasks/${taskId}/shares`, b),
  revokeShare: (taskId: string, id: string) => request<ShareLink[]>('DELETE', `/tasks/${taskId}/shares/${id}`),
};
