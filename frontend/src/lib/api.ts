import type { AuthResult, Board, Project, Task } from '../types';

const ACCESS_KEY = 'teamcrm.access';
const REFRESH_KEY = 'teamcrm.refresh';

export const tokens = {
  get access() {
    return localStorage.getItem(ACCESS_KEY);
  },
  get refresh() {
    return localStorage.getItem(REFRESH_KEY);
  },
  set(access: string, refresh: string) {
    localStorage.setItem(ACCESS_KEY, access);
    localStorage.setItem(REFRESH_KEY, refresh);
  },
  clear() {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

export class ApiError extends Error {
  constructor(public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
}

const BASE = '/api';

async function rawRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  withAuth = true,
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (withAuth && tokens.access) headers['Authorization'] = `Bearer ${tokens.access}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let env: Envelope<T>;
  try {
    env = await res.json();
  } catch {
    throw new ApiError('INTERNAL', `Bad response (${res.status})`);
  }
  if (!env.ok) {
    throw new ApiError(env.error?.code ?? 'INTERNAL', env.error?.message ?? 'Error', env.error?.details);
  }
  return env.data as T;
}

let refreshing: Promise<void> | null = null;

async function tryRefresh(): Promise<void> {
  if (!tokens.refresh) throw new ApiError('UNAUTHORIZED', 'No refresh token');
  if (!refreshing) {
    refreshing = rawRequest<AuthResult>('POST', '/auth/refresh', { refreshToken: tokens.refresh }, false)
      .then((r) => {
        tokens.set(r.accessToken, r.refreshToken);
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

/** Запрос с авто-обновлением access-токена при 401/UNAUTHORIZED. */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  try {
    return await rawRequest<T>(method, path, body);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'UNAUTHORIZED' && tokens.refresh) {
      await tryRefresh();
      return await rawRequest<T>(method, path, body);
    }
    throw e;
  }
}

export const api = {
  // auth
  register: (b: { tenantName: string; email: string; password: string; fullName: string; dataRegion?: string }) =>
    rawRequest<AuthResult>('POST', '/auth/register', b, false),
  login: (b: { email: string; password: string }) =>
    rawRequest<AuthResult>('POST', '/auth/login', b, false),
  logout: () => (tokens.refresh ? rawRequest('POST', '/auth/logout', { refreshToken: tokens.refresh }, false) : Promise.resolve()),
  organizations: () => request<import('../types').OrgRef[]>('GET', '/auth/organizations'),
  switchOrg: (tenantId: string) => request<AuthResult>('POST', '/auth/switch-org', { tenantId }),
  createOrg: (name: string) => request<AuthResult>('POST', '/auth/organizations', { name }),
  me: () => request<any>('GET', '/me'),
  /** Скачивает защищённый файл (нужен Bearer) как Blob — файлы за JwtAuthGuard, прямая ссылка даёт 401. */
  authedBlob: async (path: string): Promise<Blob> => {
    const res = await fetch(path, { headers: tokens.access ? { Authorization: `Bearer ${tokens.access}` } : {} });
    if (!res.ok) throw new ApiError('INTERNAL', `Не удалось загрузить файл (${res.status})`);
    return res.blob();
  },
  /** Возвращает blob-URL защищённого файла для <img>/<a>. */
  authedObjectUrl: async (path: string): Promise<string> => URL.createObjectURL(await api.authedBlob(path)),

  // Этап D — карточка задачи
  listComments: (taskId: string) => request<any[]>('GET', `/tasks/${taskId}/comments`),
  addComment: (taskId: string, body: string, isClientVisible?: boolean) => request<any>('POST', `/tasks/${taskId}/comments`, { body, isClientVisible }),
  deleteComment: (taskId: string, cid: string) => request<any>('DELETE', `/tasks/${taskId}/comments/${cid}`),
  listAttachments: (taskId: string) => request<any[]>('GET', `/tasks/${taskId}/attachments`),
  deleteAttachment: (taskId: string, aid: string) => request<any>('DELETE', `/tasks/${taskId}/attachments/${aid}`),
  uploadAttachment: async (taskId: string, file: File) => {
    const fd = new FormData(); fd.append('file', file);
    const res = await fetch(`/api/tasks/${taskId}/attachments`, { method: 'POST', headers: tokens.access ? { Authorization: `Bearer ${tokens.access}` } : {}, body: fd });
    const env = await res.json();
    if (!env.ok) throw new ApiError(env.error?.code ?? 'INTERNAL', env.error?.message ?? 'Upload error');
    return env.data;
  },
  listChecklist: (taskId: string) => request<any[]>('GET', `/tasks/${taskId}/checklist`),
  addChecklist: (taskId: string, text: string) => request<any>('POST', `/tasks/${taskId}/checklist`, { text }),
  patchChecklist: (taskId: string, iid: string, b: { text?: string; isDone?: boolean }) => request<any>('PATCH', `/tasks/${taskId}/checklist/${iid}`, b),
  deleteChecklist: (taskId: string, iid: string) => request<any>('DELETE', `/tasks/${taskId}/checklist/${iid}`),
  listLabels: () => request<any[]>('GET', '/labels'),
  createLabel: (b: { name: string; color?: string }) => request<any>('POST', '/labels', b),
  taskLabels: (taskId: string) => request<any[]>('GET', `/tasks/${taskId}/labels`),
  assignLabel: (taskId: string, labelId: string) => request<any>('POST', `/tasks/${taskId}/labels/${labelId}`),
  unassignLabel: (taskId: string, labelId: string) => request<any>('DELETE', `/tasks/${taskId}/labels/${labelId}`),
  taskActivity: (taskId: string) => request<any[]>('GET', `/tasks/${taskId}/activity`),

  // Этап C — личный кабинет
  updateProfile: (b: { fullName?: string; phone?: string; timezone?: string; locale?: string }) =>
    request<any>('PATCH', '/me', b),
  changePassword: (b: { currentPassword: string; newPassword: string }) =>
    request<any>('POST', '/me/password', b),
  setNotifications: (prefs: Record<string, unknown>) => request<any>('PUT', '/me/notifications', { prefs }),
  myAvailability: () => request<any[]>('GET', '/me/availability'),
  addMyAvailability: (b: { kind: string; fromDate: string; toDate: string }) => request<any>('POST', '/me/availability', b),
  removeMyAvailability: (id: string) => request<any>('DELETE', `/me/availability/${id}`),
  listSessions: () => request<any[]>('GET', '/me/sessions'),
  revokeSession: (id: string) => request<any>('DELETE', `/me/sessions/${id}`),
  revokeOtherSessions: () => request<any>('POST', '/me/sessions/revoke-all'),
  uploadAvatar: async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/me/avatar', {
      method: 'POST',
      headers: tokens.access ? { Authorization: `Bearer ${tokens.access}` } : {},
      body: fd,
    });
    const env = await res.json();
    if (!env.ok) throw new ApiError(env.error?.code ?? 'INTERNAL', env.error?.message ?? 'Upload error');
    return env.data;
  },

  // projects / board
  listProjects: () => request<Project[]>('GET', '/projects'),
  createProject: (b: { name: string; budget?: number }) => request<Project>('POST', '/projects', b),
  deleteProject: (id: string) => request<{ deleted: boolean }>('DELETE', `/projects/${id}`),
  getBoard: (projectId: string) => request<Board>('GET', `/projects/${projectId}/board`),
  // колонки доски
  addColumn: (projectId: string, name: string) => request<any>('POST', `/projects/${projectId}/columns`, { name }),
  renameColumn: (projectId: string, colId: string, name: string) => request<any>('PATCH', `/projects/${projectId}/columns/${colId}`, { name }),
  moveColumn: (projectId: string, colId: string, direction: 'left' | 'right') => request<any>('POST', `/projects/${projectId}/columns/${colId}/move`, { direction }),
  reorderColumns: (projectId: string, orderedIds: string[]) => request<any>('POST', `/projects/${projectId}/columns/reorder`, { orderedIds }),
  deleteColumn: (projectId: string, colId: string) => request<{ deleted: boolean }>('DELETE', `/projects/${projectId}/columns/${colId}`),

  // tasks
  createTask: (b: { projectId: string; title: string; columnId?: string; description?: string; assigneeId?: string; managerId?: string }) =>
    request<Task>('POST', '/tasks', b),
  updateTask: (id: string, b: Partial<{ title: string; description: string; isBlocked: boolean; priority: string; managerId: string | null }>) =>
    request<Task>('PATCH', `/tasks/${id}`, b),
  moveTask: (id: string, b: { columnId: string; position: number }) =>
    request<Task>('POST', `/tasks/${id}/move`, b),

  // клиентский портал (Этап 5)
  portalProjects: () => request<any[]>('GET', '/portal/projects'),
  portalBoard: (id: string) => request<any>('GET', `/portal/projects/${id}/board`),
  portalClients: () => request<any[]>('GET', '/portal/clients'),
  portalCreateClient: (b: { name: string; contact?: string }) => request<any>('POST', '/portal/clients', b),
  portalInviteClient: (cid: string, email: string) => request<{ token: string; email: string }>('POST', `/portal/clients/${cid}/invite`, { email }),
  portalAssignProject: (projectId: string, clientId: string | null) => request<any>('POST', `/portal/projects/${projectId}/assign`, { clientId }),

  // AI Brain (Этап 5, K2)
  brainStart: () => request<{ id: string }>('POST', '/brain/conversations'),
  brainAsk: (id: string, question: string, projectId?: string) => request<{ answer: string; citations: any[]; cached: boolean; promptVersionId: string | null }>('POST', `/brain/conversations/${id}/ask`, { question, projectId }),
  aiUsage: () => request<{ totalCalls: number; cacheHits: number; cacheHitRatio: number; byFeature: any[] }>('GET', '/ai/usage'),
  aiSettingsGet: () => request<any>('GET', '/ai/settings'),
  aiSettingsSave: (b: { openaiKey?: string; anthropicKey?: string; brainModel?: string }) => request<any>('PUT', '/ai/settings', b),
  aiSettingsModels: () => request<string[]>('GET', '/ai/settings/models'),

  // PromptOps — версионирование промптов (enh-07)
  prompts: () => request<any[]>('GET', '/prompts'),
  promptVersions: (key: string) => request<any>('GET', `/prompts/${encodeURIComponent(key)}/versions`),
  promptCreateVersion: (key: string, b: { body: string; model?: string; note?: string }) =>
    request<any>('POST', `/prompts/${encodeURIComponent(key)}/versions`, b),
  promptActivate: (key: string, v: number) => request<any>('POST', `/prompts/${encodeURIComponent(key)}/versions/${v}/activate`),
  promptAbTest: (key: string, v: number, split: number) => request<any>('POST', `/prompts/${encodeURIComponent(key)}/versions/${v}/ab`, { split }),
  promptDeprecate: (key: string, v: number) => request<any>('POST', `/prompts/${encodeURIComponent(key)}/versions/${v}/deprecate`),
  promptMetrics: (key: string, days = 30) => request<any>('GET', `/prompts/${encodeURIComponent(key)}/metrics?days=${days}`),
  promptOptimize: (key: string, days = 30) => request<{ key: string; currentVersion: number; current: string; suggestion: string | null; rationale: string | null; warning: string | null; metrics: string; model: string | null }>('POST', `/prompts/${encodeURIComponent(key)}/optimize?days=${days}`),
  promptFeedback: (b: { promptVersionId: string; rating: 1 | -1; reworked?: boolean }) => request<{ ok: boolean }>('POST', '/prompt-feedback', b),

  // база знаний (Этап 5, K1)
  knowledgeSearch: (q: string, k = 8, projectId?: string) => request<any[]>('GET', `/knowledge/search?q=${encodeURIComponent(q)}&k=${k}${projectId ? `&projectId=${projectId}` : ''}`),
  knowledgeStats: () => request<{ chunks: string; sources: string }>('GET', '/knowledge/stats'),
  knowledgeReindex: () => request<{ queued: number }>('POST', '/knowledge/reindex'),
  listRegulations: () => request<any[]>('GET', '/regulations'),
  getRegulation: (id: string) => request<any>('GET', `/regulations/${id}`),
  createRegulation: (b: { title: string; body: string }) => request<any>('POST', '/regulations', b),
  updateRegulation: (id: string, b: { title: string; body: string }) => request<any>('PUT', `/regulations/${id}`, b),
  deleteRegulation: (id: string) => request<any>('DELETE', `/regulations/${id}`),

  // интеграции — Битрикс24 (импорт)
  bitrixConnections: () => request<any[]>('GET', '/integrations/bitrix/connections'),
  bitrixConnect: (webhookUrl: string, label?: string) => request<any>('POST', '/integrations/bitrix/connections', { webhookUrl, label }),
  bitrixDisconnect: (cid: string) => request<any>('DELETE', `/integrations/bitrix/connections/${cid}`),
  bitrixProjects: (cid: string) => request<{ externalId: string; name: string }[]>('GET', `/integrations/bitrix/connections/${cid}/projects`),
  bitrixImport: (cid: string, projectExternalIds: string[], includeGeneralFeed = false) => request<{ runId: string; status: string }>('POST', `/integrations/bitrix/connections/${cid}/import`, { projectExternalIds, includeGeneralFeed }),
  bitrixAnalyzeUngrouped: (cid: string) => request<{ projects: { id: string; name: string }[]; tasks: { externalId: string; title: string; suggestedProjectId: string | null; confidence: number }[] }>('POST', `/integrations/bitrix/connections/${cid}/ungrouped/analyze`),
  bitrixApplyUngrouped: (cid: string, assignments: { externalId: string; projectId: string | null }[]) => request<{ runId: string; status: string }>('POST', `/integrations/bitrix/connections/${cid}/ungrouped/apply`, { assignments }),
  bitrixRun: (id: string) => request<any>('GET', `/integrations/bitrix/runs/${id}`),
  bitrixUnmatched: (cid: string) => request<{ externalId: string; name: string; email: string }[]>('GET', `/integrations/bitrix/connections/${cid}/unmatched-users`),
  bitrixMapUser: (cid: string, externalUserId: string, localUserId: string) => request<any>('POST', `/integrations/bitrix/connections/${cid}/user-map`, { externalUserId, localUserId }),
  bitrixMessages: (projectId: string) => request<any[]>('GET', `/integrations/bitrix/projects/${projectId}/messages`),

  // deals
  listDeals: () => request<any[]>('GET', '/deals'),
  createDeal: (b: { title: string; amount?: number; plannedMargin?: number }) =>
    request<any>('POST', '/deals', b),
  convertDeal: (id: string) => request<any>('POST', `/deals/${id}/convert`),

  // Этап 2 — time tracking & economics
  startTimer: (taskId: string) => request<import('../types').ActiveTimer>('POST', `/tasks/${taskId}/timer/start`),
  stopTimer: (taskId: string) => request<import('../types').ActiveTimer>('POST', `/tasks/${taskId}/timer/stop`),
  myTimer: () => request<import('../types').ActiveTimer | null>('GET', '/me/timer'),
  getPnl: (projectId: string) => request<import('../types').Pnl>('GET', `/projects/${projectId}/pnl`),
  createRate: (b: { userId: string; hourlyRate: number }) => request<any>('POST', '/rates', b),

  // Этап 3 — Telegram binding & standup
  telegramLinkCode: () => request<{ code: string; expiresAt: string }>('POST', '/me/telegram/link-code'),
  listStandups: () => request<any[]>('GET', '/standup/submissions'),

  // users / team
  listUsers: () => request<any[]>('GET', '/users'),
  createUser: (b: { email: string; fullName: string; password: string; role?: string; positionId?: string; groupIds?: string[] }) =>
    request<any>('POST', '/users', b),
  updateUser: (id: string, b: { role?: string; positionId?: string | null; groupIds?: string[]; isActive?: boolean }) =>
    request<any>('PATCH', `/users/${id}`, b),
  // positions
  listPositions: () => request<any[]>('GET', '/positions'),
  createPosition: (name: string) => request<any>('POST', '/positions', { name }),
  deletePosition: (id: string) => request<any>('DELETE', `/positions/${id}`),
  // groups
  listGroups: () => request<any[]>('GET', '/groups'),
  createGroup: (b: { name: string; kind?: string }) => request<any>('POST', '/groups', b),
  deleteGroup: (id: string) => request<any>('DELETE', `/groups/${id}`),
  groupMembers: (id: string) => request<any[]>('GET', `/groups/${id}/members`),
  addGroupMember: (id: string, userId: string) => request<any>('POST', `/groups/${id}/members`, { userId }),
  removeGroupMember: (id: string, userId: string) => request<any>('DELETE', `/groups/${id}/members/${userId}`),
  // invites
  createInvite: (b: { email: string; role: string; positionId?: string }) => request<{ token: string; email: string }>('POST', '/invites', b),
  acceptInvite: (b: { token: string; fullName: string; password: string }) =>
    rawRequest<any>('POST', '/invites/accept', b, false),

  // Этап 4 — forecast, assignment, velocity, copilot
  assignTask: (id: string, b: { assigneeId: string; confirmOverload?: boolean; estimateHours?: number; deadlineAt?: string }) =>
    request<any>('POST', `/tasks/${id}/assign`, b),
  getForecast: (id: string) => request<any>('GET', `/tasks/${id}/forecast`),
  getVelocity: (userId: string) => request<any>('GET', `/users/${userId}/velocity`),
  getLoad: (userId: string) => request<any>('GET', `/users/${userId}/load`),
  copilotScan: () => request<any[]>('POST', '/copilot/scan'),
  listRecommendations: () => request<any[]>('GET', '/recommendations'),
  acceptRecommendation: (id: string) => request<any>('POST', `/recommendations/${id}/accept`),
  dismissRecommendation: (id: string) => request<any>('POST', `/recommendations/${id}/dismiss`),
};
