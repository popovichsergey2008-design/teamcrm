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
  me: () => request<import('../types').User>('GET', '/me'),

  // projects / board
  listProjects: () => request<Project[]>('GET', '/projects'),
  createProject: (b: { name: string; budget?: number }) => request<Project>('POST', '/projects', b),
  getBoard: (projectId: string) => request<Board>('GET', `/projects/${projectId}/board`),

  // tasks
  createTask: (b: { projectId: string; title: string; columnId?: string; description?: string }) =>
    request<Task>('POST', '/tasks', b),
  updateTask: (id: string, b: Partial<{ title: string; description: string; isBlocked: boolean }>) =>
    request<Task>('PATCH', `/tasks/${id}`, b),
  moveTask: (id: string, b: { columnId: string; position: number }) =>
    request<Task>('POST', `/tasks/${id}/move`, b),

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
