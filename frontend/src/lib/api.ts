import type { AiAction, Approval, AuthResult, Board, Focus, GateSettings, Project, SearchResults, SemanticHit, Task } from '../types';

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

/**
 * Изменили задачу — сообщаем об этом всему приложению.
 *
 * Иначе счётчики в левой панели пришлось бы дёргать из каждого места, где задачу
 * создают, двигают, закрывают или удаляют: доска, карточка, список, быстрая команда,
 * разбор встречи. Один сигнал из общего места честнее пяти забытых вызовов.
 */
function announceTaskChange(method: string, path: string) {
  if (method === 'GET') return;
  if (!path.startsWith('/tasks')) return;
  window.dispatchEvent(new Event('teamcrm:tasks-changed'));
}

/** Запрос с авто-обновлением access-токена при 401/UNAUTHORIZED. */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  try {
    const res = await rawRequest<T>(method, path, body);
    announceTaskChange(method, path);
    return res;
  } catch (e) {
    if (e instanceof ApiError && e.code === 'UNAUTHORIZED' && tokens.refresh) {
      await tryRefresh();
      const res = await rawRequest<T>(method, path, body);
      announceTaskChange(method, path);
      return res;
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
  updateProfile: (b: { fullName?: string; phone?: string; timezone?: string; locale?: string; radarStuckHours?: number | null; calendarBlockOverlap?: boolean }) =>
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

  // текущий фокус: над чем человек работает и до какого времени
  getFocus: () => request<Focus | null>('GET', '/focus/me'),
  setFocus: (b: { kind: string; note?: string; minutes?: number; taskId?: string }) =>
    request<Focus>('PUT', '/focus/me', b),
  clearFocus: () => request<{ cleared: boolean }>('DELETE', '/focus/me'),
  /** Кто чем занят прямо сейчас: для ответа «кто свободен» без похода к людям. */
  focusTeam: () => request<Focus[]>('GET', '/focus/team'),

  // AI Секретарь: что система сделала за людей сама
  secretarySummary: () =>
    request<{ actions: number; savedMinutes: number }>(
      'GET', `/secretary/summary?tz=${new Date().getTimezoneOffset()}`,
    ),
  secretaryLog: (limit = 50) => request<AiAction[]>('GET', `/secretary/log?limit=${limit}`),

  /**
   * Поиск по смыслу: эмбеддинг запроса + pgvector по архиву (задачи, комментарии,
   * встречи, доки, регламенты). Стоит одного дешёвого запроса к модели, поэтому
   * вызывается явным действием, а не на каждую букву.
   */
  semanticSearch: (q: string) =>
    request<SemanticHit[]>('GET', `/knowledge/search?q=${encodeURIComponent(q)}&k=6`),

  /** Разовый вопрос ИИ со ссылками на источники (тот же конвейер и кэш, что у «Спросить ИИ»). */
  brainAnswer: (question: string) =>
    request<{ answer: string; citations: { sourceType: string; sourceId: string; title: string | null }[]; cached: boolean }>(
      'POST', '/brain/answer', { question },
    ),

  /** Поиск командной строки: одна ручка на все источники, права проверяет сервер. */
  search: (q: string) => request<SearchResults>('GET', `/search?q=${encodeURIComponent(q)}`),

  /** Сводка «Пульса команды»: проекты, загрузка людей, узкие места, скорость. */
  radar: () => request<{
    projects: { id: string; name: string; total: number; closed: number; overdue: number; next_deadline: string | null }[];
    people: { user_id: string; full_name: string; open: number; overdue: number; due_today: number }[];
    stuck: { id: string; project_id: string; title: string; project_name: string; column_name: string; updated_at: string; assignee_name: string | null }[];
    stuckHours: number;
    velocity: { last7: number; prev7: number };
  }>('GET', `/radar?tz=${new Date().getTimezoneOffset()}`),

  /**
   * Счётчики бейджей левой панели одним запросом.
   * Часовой пояс отдаём свой: «сегодня» у человека и на сервере — разные дни.
   */
  navCounters: () =>
    request<{ focus: { decide: number; today: number }; radar: { risks: number } | null }>(
      'GET', `/nav/counters?tz=${new Date().getTimezoneOffset()}`,
    ),

  // projects / board
  listProjects: (includeArchived = false) =>
    request<Project[]>('GET', `/projects${includeArchived ? '?archived=1' : ''}`),
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
  createTask: (b: {
    projectId: string; title: string; columnId?: string; description?: string;
    assigneeId?: string; managerId?: string;
    priority?: string; deadlineAt?: string; estimateHours?: number; labelIds?: string[];
  }) =>
    request<Task>('POST', '/tasks', b),
  updateTask: (id: string, b: Partial<{ title: string; description: string; isBlocked: boolean; priority: string; managerId: string | null }>) =>
    request<Task>('PATCH', `/tasks/${id}`, b),
  moveTask: (id: string, b: { columnId: string; position: number; confirmGate?: boolean }) =>
    request<Task>('POST', `/tasks/${id}/move`, b),

  // условия приёмки работы: читают все, меняет владелец
  handoffGate: () => request<GateSettings>('GET', '/handoff-gate'),
  saveHandoffGate: (b: GateSettings) => request<GateSettings>('PUT', '/handoff-gate', b),

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
  /** Стрим ответа Brain (SSE): onCitations → onDelta* → onDone|onError. Возвращает true, если поток отработал. */
  brainAskStream: async (
    id: string, question: string, projectId: string | undefined,
    on: { onCitations?: (c: any[]) => void; onDelta?: (t: string) => void; onDone?: (d: { messageId: string; cached: boolean; promptVersionId: string | null }) => void; onError?: (m: string) => void },
  ): Promise<boolean> => {
    const res = await fetch(`${BASE}/brain/conversations/${id}/ask/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(tokens.access ? { Authorization: `Bearer ${tokens.access}` } : {}) },
      body: JSON.stringify({ question, projectId }),
    });
    if (!res.ok || !res.body) return false; // вызывающий откатится на нестрим-brainAsk
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const ev = /event: (.+)/.exec(block)?.[1];
        const dm = /data: ([\s\S]+)/.exec(block)?.[1];
        if (!ev || !dm) continue;
        let data: any; try { data = JSON.parse(dm); } catch { continue; }
        if (ev === 'citations') on.onCitations?.(data.citations);
        else if (ev === 'delta') on.onDelta?.(data.text);
        else if (ev === 'done') on.onDone?.(data);
        else if (ev === 'error') on.onError?.(data.message);
      }
    }
    return true;
  },
  aiUsage: () => request<{ totalCalls: number; cacheHits: number; cacheHitRatio: number; byFeature: any[] }>('GET', '/ai/usage'),
  aiSettingsGet: () => request<any>('GET', '/ai/settings'),
  aiSettingsSave: (b: { openaiKey?: string; anthropicKey?: string; openrouterKey?: string; brainModel?: string }) => request<any>('PUT', '/ai/settings', b),
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
  bitrixUnmatched: (cid: string) => request<{ total: number; items: { externalId: string; name: string; email: string }[] }>('GET', `/integrations/bitrix/connections/${cid}/unmatched-users`),
  bitrixDiagnostics: (cid: string) => request<{ scopes: string[]; scopesError: string | null; ungrouped: { count: number | null; error: string | null }; feed: { count: number | null; error: string | null }; groups: { count: number | null; error: string | null } }>('GET', `/integrations/bitrix/connections/${cid}/diagnostics`),
  bitrixMapUser: (cid: string, externalUserId: string, localUserId: string) => request<any>('POST', `/integrations/bitrix/connections/${cid}/user-map`, { externalUserId, localUserId }),
  bitrixMessages: (projectId: string) => request<any[]>('GET', `/integrations/bitrix/projects/${projectId}/messages`),
  // YouGile (E1)
  yougileConnections: () => request<any[]>('GET', '/integrations/yougile/connections'),
  yougileConnect: (apiKey: string, label?: string) => request<any>('POST', '/integrations/yougile/connections', { apiKey, label }),
  yougileDisconnect: (cid: string) => request<any>('DELETE', `/integrations/yougile/connections/${cid}`),
  yougileBoards: (cid: string) => request<{ externalId: string; title: string; projectTitle: string | null }[]>('GET', `/integrations/yougile/connections/${cid}/boards`),
  yougileImport: (cid: string, boardExternalIds: string[]) => request<{ runId: string }>('POST', `/integrations/yougile/connections/${cid}/import`, { boardExternalIds }),
  yougileRun: (id: string) => request<any>('GET', `/integrations/yougile/runs/${id}`),
  yougileUnmatched: (cid: string) => request<{ total: number; items: { externalId: string; name: string; email: string }[] }>('GET', `/integrations/yougile/connections/${cid}/unmatched-users`),
  yougileMapUser: (cid: string, externalUserId: string, localUserId: string) =>
    request<{ mapped: boolean; tasksToRefresh: number }>('POST', `/integrations/yougile/connections/${cid}/user-map`, { externalUserId, localUserId }),
  yougileEnableLive: (cid: string) => request<{ url: string; events: string[]; created: string[] }>('POST', `/integrations/yougile/connections/${cid}/enable-live`),
  // E4: обратная выгрузка CRM → YouGile
  yougileSetPush: (cid: string, enabled: boolean) => request<{ pushEnabled: boolean; liveEvents: string[] }>('POST', `/integrations/yougile/connections/${cid}/push`, { enabled }),
  yougilePushStatus: (cid: string) => request<{
    pushEnabled: boolean; pending: number; done: number; errors: number;
    lastError: { kind: string; message: string; at: string } | null;
  }>('GET', `/integrations/yougile/connections/${cid}/push`),
  // Google-доки из задач → база знаний
  // ИИ-агенты
  agentRun: (taskId: string) => request<{ id: string; status: string; result: string; commentId: string | null; citations: any[] }>('POST', `/agents/tasks/${taskId}/run`),
  agentExecute: (taskId: string, opts?: { presetId?: string; instruction?: string; model?: string }) => request<{ id: string; status: string; declined?: boolean; result: string; commentId: string | null; movedTo: string | null; fileName?: string | null }>('POST', `/agents/tasks/${taskId}/execute`, opts ?? {}),
  agentRuns: (taskId: string) => request<any[]>('GET', `/agents/tasks/${taskId}/runs`),
  agentAccept: (runId: string, toChecklist: boolean) => request<{ accepted: boolean; addedChecklist: number }>('POST', `/agents/runs/${runId}/accept`, { toChecklist }),
  agentReject: (runId: string) => request<{ rejected: boolean }>('POST', `/agents/runs/${runId}/reject`),
  agentRework: (runId: string, feedback: string) => request<{ id: string; status: string; result: string; movedTo: string | null }>('POST', `/agents/runs/${runId}/rework`, { feedback }),
  agentAssign: (taskId: string, autoRun = true, opts?: { presetId?: string; instruction?: string; model?: string }) =>
    request<{ assigned: boolean; run: { status: string; declined?: boolean; movedTo: string | null; fileName?: string | null } | null }>('POST', `/agents/tasks/${taskId}/assign`, { autoRun, ...(opts ?? {}) }),
  agentUnassign: (taskId: string) => request<{ assigned: boolean }>('POST', `/agents/tasks/${taskId}/unassign`),
  // библиотека промптов агента
  agentModels: () => request<string[]>('GET', '/agents/models'),
  agentPrompts: () => request<any[]>('GET', '/agents/prompts'),
  agentPromptCreate: (b: { name: string; instruction: string; model?: string; isShared?: boolean }) => request<any>('POST', '/agents/prompts', b),
  agentPromptUpdate: (id: string, b: { name?: string; instruction?: string; model?: string; isShared?: boolean }) => request<any>('PATCH', `/agents/prompts/${id}`, b),
  agentPromptDelete: (id: string) => request<any>('DELETE', `/agents/prompts/${id}`),
  // NL-команда / Zero-UI
  nlParse: (text: string) => request<any>('POST', '/nl/parse', { text }),
  nlApply: (body: { intent: string; task?: any; deal?: any }) => request<any>('POST', '/nl/apply', body),
  /** Голосовая команда: аудио-запись → Whisper → распознанный текст. */
  nlTranscribe: async (blob: Blob): Promise<{ text: string }> => {
    const fd = new FormData();
    fd.append('audio', blob, 'command.webm');
    const res = await fetch(`${BASE}/nl/transcribe`, { method: 'POST', headers: tokens.access ? { Authorization: `Bearer ${tokens.access}` } : {}, body: fd });
    const env = await res.json().catch(() => ({ ok: false }));
    if (!env.ok) throw new ApiError(env.error?.code ?? 'INTERNAL', env.error?.message ?? 'Ошибка распознавания речи');
    return env.data;
  },
  // Входящие → авто-задачи
  inboxSources: () => request<any[]>('GET', '/inbox/sources'),
  inboxCreateSource: (label?: string, defaultProjectId?: string) => request<any>('POST', '/inbox/sources', { label, defaultProjectId }),
  inboxDeleteSource: (id: string) => request<any>('DELETE', `/inbox/sources/${id}`),
  inboxItems: (status = 'pending') => request<any[]>('GET', `/inbox/items?status=${status}`),
  /** Голосовая заметка → черновик задачи на ревью (Whisper). */
  inboxVoice: async (blob: Blob, defaultProjectId?: string): Promise<{ itemId: string; text: string }> => {
    const fd = new FormData();
    fd.append('audio', blob, 'note.webm');
    if (defaultProjectId) fd.append('defaultProjectId', defaultProjectId);
    const res = await fetch(`${BASE}/inbox/voice`, { method: 'POST', headers: tokens.access ? { Authorization: `Bearer ${tokens.access}` } : {}, body: fd });
    const env = await res.json().catch(() => ({ ok: false }));
    if (!env.ok) throw new ApiError(env.error?.code ?? 'INTERNAL', env.error?.message ?? 'Ошибка распознавания речи');
    return env.data;
  },
  inboxConfirm: (id: string, task: any) => request<any>('POST', `/inbox/items/${id}/confirm`, { task }),
  inboxDismiss: (id: string) => request<any>('POST', `/inbox/items/${id}/dismiss`),
  knowledgeSources: (p: { projectId?: string; type?: string; q?: string; offset?: number }) => {
    const qs = new URLSearchParams();
    if (p.projectId) qs.set('projectId', p.projectId);
    if (p.type) qs.set('type', p.type);
    if (p.q) qs.set('q', p.q);
    if (p.offset) qs.set('offset', String(p.offset));
    return request<{ items: any[]; hasMore: boolean; offset: number; limit: number }>('GET', `/knowledge/sources?${qs.toString()}`);
  },
  knowledgeSource: (type: string, id: string) => request<{ sourceType: string; title: string | null; text: string; url?: string | null; projectName?: string | null }>('GET', `/knowledge/sources/${type}/${id}`),
  gdocsScan: () => request<{ started: boolean }>('POST', '/integrations/gdocs/scan'),
  gdocsStatus: () => request<{ scanning: boolean; total: number; byStatus: Record<string, number> }>('GET', '/integrations/gdocs/status'),

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
  getProjectCostOfWork: (projectId: string) => request<import('../types').CostOfWork>('GET', `/projects/${projectId}/cost-of-work`),
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
  // почтовые уведомления
  notificationPrefs: () => request<{ eventKey: string; title: string; enabled: boolean }[]>('GET', '/notifications/prefs'),
  setNotificationPref: (eventKey: string, enabled: boolean) =>
    request<{ ok: true }>('PUT', '/notifications/prefs', { eventKey, enabled }),
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
  // многоразовые ссылки-приглашения
  createInviteLink: (b: { role?: string; positionId?: string; maxUses?: number; expiresInDays?: number }) =>
    request<{ token: string; id: string; role: string; maxUses: number | null; expiresAt: string | null }>('POST', '/invites/links', b),
  listInviteLinks: () => request<any[]>('GET', '/invites/links'),
  deleteInviteLink: (id: string) => request<any>('DELETE', `/invites/links/${id}`),
  inviteLinkInfo: (token: string) => rawRequest<{ tenantName: string; role: string }>('GET', `/invites/links/${token}/info`, undefined, false),
  acceptInviteLink: (b: { token: string; email: string; fullName: string; password: string }) =>
    rawRequest<any>('POST', '/invites/links/accept', b, false),

  // мессенджер команды
  listChats: () => request<any[]>('GET', '/chats'),
  openDm: (userId: string) => request<{ id: string; kind: string }>('POST', '/chats/dm', { userId }),
  createChatGroup: (title: string, userIds: string[]) => request<any>('POST', '/chats/groups', { title, userIds }),
  openProjectChat: (projectId: string) => request<{ id: string; kind: string }>('POST', `/chats/project/${projectId}`),
  chatMessages: (chatId: string, before?: string) =>
    request<any[]>('GET', `/chats/${chatId}/messages${before ? `?before=${before}` : ''}`),
  sendChatMessage: (chatId: string, body: string) => request<any>('POST', `/chats/${chatId}/messages`, { body }),
  markChatRead: (chatId: string) => request<any>('POST', `/chats/${chatId}/read`),
  chatMembers: (chatId: string) => request<{
    canManage: boolean; createdBy: string | null; members: { userId: string; fullName: string }[];
  }>('GET', `/chats/${chatId}/members`),
  addChatMembers: (chatId: string, userIds: string[]) => request<{ added: number }>('POST', `/chats/${chatId}/members`, { userIds }),
  removeChatMember: (chatId: string, userId: string) => request<any>('DELETE', `/chats/${chatId}/members/${userId}`),
  renameChat: (chatId: string, title: string) => request<{ title: string }>('PATCH', `/chats/${chatId}`, { title }),
  leaveChat: (chatId: string) => request<any>('POST', `/chats/${chatId}/leave`),
  deleteChatMessage: (chatId: string, messageId: string) => request<any>('DELETE', `/chats/${chatId}/messages/${messageId}`),
  sendChatFile: async (chatId: string, file: File, body: string) => {
    const fd = new FormData();
    fd.append('file', file);
    if (body) fd.append('body', body);
    const res = await fetch(`/api/chats/${chatId}/files`, {
      method: 'POST', headers: tokens.access ? { Authorization: `Bearer ${tokens.access}` } : {}, body: fd,
    });
    const env = await res.json();
    if (!env.ok) throw new ApiError(env.error?.code ?? 'INTERNAL', env.error?.message ?? 'Не удалось отправить файл');
    return env.data;
  },

  // созвоны (mediasoup)
  mediaHealth: () => request<{ available: boolean; workers: number; error: string | null }>('GET', '/media/health'),
  iceServers: () => request<{ iceServers: RTCIceServer[] }>('GET', '/media/ice'),
  activeCalls: () => request<{ id: string; projectId: string | null; participants: { userId: string; displayName: string }[] }[]>('GET', '/media/rooms'),
  startCall: (projectId?: string, withAi = false) =>
    request<{ id: string; projectId: string | null; aiEnabled: boolean }>('POST', '/media/rooms', { projectId, withAi }),

  // лента компании: сообщения и объявления
  feedList: (before?: string) =>
    request<{ items: any[] }>('GET', `/feed${before ? `?before=${before}` : ''}`),
  feedUnread: () => request<{ items: any[]; count: number }>('GET', '/feed/unread'),
  feedCreate: (b: { body: string; isAnnouncement?: boolean; activeUntil?: string; groupIds?: string[] }) =>
    request<any>('POST', '/feed', b),
  feedRead: (id: string) => request<any>('POST', `/feed/${id}/read`),
  feedReaders: (id: string) =>
    request<{ read: { fullName: string }[]; pending: { fullName: string }[] }>('GET', `/feed/${id}/readers`),
  feedComments: (id: string) => request<any[]>('GET', `/feed/${id}/comments`),
  feedComment: (id: string, body: string) => request<any[]>('POST', `/feed/${id}/comments`, { body }),
  feedPin: (id: string, pinned: boolean) => request<any>('POST', `/feed/${id}/pin`, { pinned }),
  feedDelete: (id: string) => request<any>('DELETE', `/feed/${id}`),

  // календарь: события людей и компании
  calendarRange: (from: string, to: string, withTasks = true) =>
    request<{ events: any[]; tasks: any[]; work: { workStart: string; workEnd: string; weekendDays: number[]; holidays: string[] } }>(
      'GET', `/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&tasks=${withTasks ? '1' : '0'}`),
  calendarPending: () => request<{ count: number }>('GET', '/calendar/pending'),
  /** Занятость людей: только интервалы, без названий чужих встреч. */
  calendarBusy: (from: string, to: string, userIds: string[], exceptEventId?: string) =>
    request<{ busy: Record<string, { startsAt: string; endsAt: string; kind: string }[]> }>(
      'GET', `/calendar/busy?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&userIds=${userIds.join(',')}`
        + (exceptEventId ? `&exceptEventId=${exceptEventId}` : '')),
  calendarCreate: (b: Record<string, unknown>) => request<any>('POST', '/calendar/events', b),
  calendarUpdate: (id: string, b: Record<string, unknown>) => request<any>('PATCH', `/calendar/events/${id}`, b),
  calendarDelete: (id: string) => request<any>('DELETE', `/calendar/events/${id}`),
  calendarRespond: (id: string, status: 'accepted' | 'declined') =>
    request<any>('POST', `/calendar/events/${id}/respond`, { status }),
  calendarWork: () => request<any>('GET', '/calendar/work'),
  /** Файл встречи: за авторизацией, поэтому тянем с токеном и отдаём как blob. */
  calendarIcs: async (id: string) => {
    const res = await fetch(`/api/calendar/events/${id}/ics`, {
      headers: tokens.access ? { Authorization: `Bearer ${tokens.access}` } : {},
    });
    if (!res.ok) throw new ApiError('INTERNAL', 'Не удалось получить файл встречи');
    return res.blob();
  },
  saveCalendarWork: (b: { workStart: string; workEnd: string; weekendDays: number[]; holidays: string[] }) =>
    request<any>('POST', '/calendar/work', b),

  // гостевой доступ в созвон по ссылке
  createGuestLink: (b: { roomId?: string; projectId?: string; label?: string; ttlHours?: number }) =>
    request<{ id: string; roomId: string; url: string; expiresAt: string }>('POST', '/meet/guest-links', b),
  listGuestLinks: () => request<any[]>('GET', '/meet/guest-links'),
  /** Войти в комнату ранее выданной ссылки — гость ждёт именно её. */
  openGuestLink: (id: string) =>
    request<{ roomId: string; projectId: string | null; label: string | null }>(
      'POST', `/meet/guest-links/${id}/open`),
  revokeGuestLink: (id: string) =>
    request<{ id: string; roomId: string; kicked: number }>('DELETE', `/meet/guest-links/${id}`),
  /** Гостевые вызовы идут БЕЗ токена: у гостя нет учётной записи и быть не может. */
  guestLinkInfo: (token: string) =>
    rawRequest<
      | { valid: true; orgName: string; label: string | null; roomActive: boolean; hostPresent: boolean }
      | { valid: false; reason: string }
    >('GET', `/meet/guest/${encodeURIComponent(token)}`, undefined, false),
  guestJoin: (token: string, name: string) =>
    rawRequest<{ token: string; roomId: string; name: string; userId: string; iceServers: RTCIceServer[] }>(
      'POST', `/meet/guest/${encodeURIComponent(token)}/join`, { name }, false),

  // встречи: запись → стенограмма → сводка → черновики задач
  listMeetings: () => request<any[]>('GET', '/meetings'),
  meetingDetails: (id: string) => request<{ meeting: any; segments: any[]; summary: any; drafts: any[] }>('GET', `/meetings/${id}`),
  uploadMeeting: async (form: FormData) => {
    const res = await fetch('/api/meetings', {
      method: 'POST',
      headers: tokens.access ? { Authorization: `Bearer ${tokens.access}` } : {},
      body: form,
    });
    const env = await res.json();
    if (!env.ok) throw new ApiError(env.error?.code ?? 'INTERNAL', env.error?.message ?? 'Не удалось загрузить запись');
    return env.data;
  },
  retryMeeting: (id: string) => request<any>('POST', `/meetings/${id}/retry`),
  applyMeetingDraft: (draftId: string, b: { title?: string; assigneeId?: string; projectId?: string }) =>
    request<any>('POST', `/meetings/drafts/${draftId}/apply`, b),
  rejectMeetingDraft: (draftId: string) => request<any>('POST', `/meetings/drafts/${draftId}/reject`),

  /** Сквозные вкладки: мои задачи и порученные другим (по всем проектам). */
  // согласования: вопросы, на которые нужен ответ «да» или «нет»
  approvalsInbox: () => request<Approval[]>('GET', '/approvals'),
  approvalsSent: (all = false) => request<Approval[]>('GET', `/approvals/sent${all ? '?all=1' : ''}`),
  createApproval: (b: { approverId: string; subject: string; kind?: string; details?: string; taskId?: string }) =>
    request<Approval>('POST', '/approvals', b),
  decideApproval: (id: string, approve: boolean, note?: string) =>
    request<Approval>('POST', `/approvals/${id}/decide`, { approve, note }),
  cancelApproval: (id: string) => request<Approval>('POST', `/approvals/${id}/cancel`),

  /** План на день: дата ГГГГ-ММ-ДД или null, чтобы снять. Дату считаем по часам человека. */
  setFocusDate: (taskId: string, date: string | null) =>
    request<Task>('PATCH', `/tasks/${taskId}/focus-date`, { date }),
  /** Незакрытое, запланированное на прошедшие дни, — хвосты для разбора. */
  leftovers: (today: string) =>
    request<(Task & { project_name: string })[]>('GET', `/tasks/my/leftovers?today=${today}`),

  myTasks: (scope: 'mine' | 'delegated' | 'review', closed = false) =>
    request<any[]>('GET', `/tasks/my?scope=${scope}${closed ? '&closed=1' : ''}`),
  // архив проектов
  archiveProject: (id: string) => request<{ archived: boolean }>('POST', `/projects/${id}/archive`),
  unarchiveProject: (id: string) => request<{ archived: boolean }>('POST', `/projects/${id}/unarchive`),

  // сброс пароля: владелец выдаёт одноразовую ссылку, человек задаёт пароль сам
  createPasswordResetLink: (userId: string) =>
    request<{ token: string; expiresAt: string; email: string; fullName: string; alsoAffectsOrgs: string[] }>(
      'POST', '/auth/password/reset-link', { userId }),
  passwordResetInfo: (token: string) =>
    rawRequest<{ email: string; fullName: string }>('GET', `/auth/password/reset/${token}`, undefined, false),
  resetPassword: (b: { token: string; password: string }) =>
    rawRequest<{ reset: boolean; email: string }>('POST', '/auth/password/reset', b, false),

  // Этап 4 — forecast, assignment, velocity, copilot
  assignTask: (id: string, b: { assigneeId: string; confirmOverload?: boolean; estimateHours?: number; deadlineAt?: string }) =>
    request<any>('POST', `/tasks/${id}/assign`, b),
  deleteTask: (id: string) => request<{ deleted: true }>('DELETE', `/tasks/${id}`),
  getForecast: (id: string) => request<any>('GET', `/tasks/${id}/forecast`),
  getVelocity: (userId: string) => request<any>('GET', `/users/${userId}/velocity`),
  getLoad: (userId: string) => request<any>('GET', `/users/${userId}/load`),
  copilotScan: () => request<any[]>('POST', '/copilot/scan'),
  listRecommendations: () => request<any[]>('GET', '/recommendations'),
  acceptRecommendation: (id: string) => request<any>('POST', `/recommendations/${id}/accept`),
  dismissRecommendation: (id: string) => request<any>('POST', `/recommendations/${id}/dismiss`),
};
