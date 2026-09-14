import type {
  Agenda, AiAction, Approval, AssistantMode, AuthResult, Board, Focus, GateSettings, Ping,
  Project, Proposal, SearchResults, SemanticHit, Task,
} from '../types';

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

/** Состояние обработки надиктовки: аудио сохранено, разбор идёт в фоне. */
export interface VoiceJob {
  id: string;
  status: 'queued' | 'transcribing' | 'parsing' | 'ready' | 'error';
  transcript: string;
  tasks: any[];
  error: string | null;
  durationSec: number | null;
}

/**
 * Расписание повтора задачи.
 *
 * Подпись (`description`) приходит С СЕРВЕРА, а не собирается на клиенте: то же
 * правило видит планировщик в журнале и человек в карточке, и разойтись в словах
 * они не должны.
 */
export interface TaskRecurrence {
  id: string;
  taskId: string;
  freq: 'daily' | 'weekly' | 'monthly' | 'days';
  /** 1 = понедельник … 7 = воскресенье. */
  weekdays: number[];
  monthday: number | null;
  intervalDays: number | null;
  atTime: string;
  tz: string;
  nextRunAt: string;
  lastRunAt: string | null;
  active: boolean;
  description: string;
}

/** Что нашлось в загруженном файле — до записи в базу. */
export interface ImportPreview {
  token: string;
  fileName: string;
  headers: string[];
  mapping: Record<string, number>;
  totalRows: number;
  sample: string[][];
  truncated: boolean;
}

/** Отчёт импорта. Предупреждения показываются целиком: импорт без отчёта — лотерея. */
export interface ImportStats {
  created: number;
  updated: number;
  skipped: number;
  projects: string[];
  warnings: string[];
}

/** Ссылка синхронизации календаря: наша наружу («export») или чужая внутрь («import»). */
/** Отложенное сообщение: разовое или ежедневное в одно и то же время. */
export interface Scheduled {
  id: string;
  chatId: string;
  body: string;
  sendAt: string;
  repeat: 'none' | 'daily';
  sentCount: number;
}

/** Сторона объединения задач: та, что остаётся, и та, что помечается объединённой. */
export interface MergeSide {
  id: string;
  title: string;
  description: string | null;
  projectId: string;
  projectName: string | null;
  assigneeName: string | null;
  managerName: string | null;
}

export interface CalendarLink {
  id: string;
  kind: 'export' | 'import';
  title: string | null;
  /** Адрес для подписки — только у нашей ссылки. Чужой секретный адрес обратно не отдаём. */
  url: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  eventsCount: number;
}

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
    /*
      Ответ не разобрался — почти всегда это не наше приложение, а пограничный
      nginx: в момент выкладки он отдаёт свою HTML-страницу с 502/503/504.
      Отличаем это от настоящей поломки: такой ответ значит «сервер сейчас
      обновляется», и запрос имеет смысл повторить.
    */
    if (res.status >= 502 && res.status <= 504) {
      throw new ApiError('UNAVAILABLE', 'Сервер обновляется — секунду…');
    }
    throw new ApiError('INTERNAL', `Bad response (${res.status})`);
  }
  if (!env.ok) {
    throw new ApiError(env.error?.code ?? 'INTERNAL', env.error?.message ?? 'Error', env.error?.details);
  }
  return env.data as T;
}

let refreshing: Promise<void> | null = null;

/** Сессия кончилась совсем: приложение должно увести человека на вход, а не показывать 401. */
export const SIGNED_OUT_EVENT = 'teamcrm:signed-out';

/**
 * Обновление access-токена.
 *
 * Две тонкости, обе выяснились живьём.
 *
 * Первая: refresh-токен на сервере ОДНОРАЗОВЫЙ — при обновлении старый отзывается.
 * Две вкладки, начавшие обновление одновременно, дрались за него, и проигравшая
 * получала «Invalid or expired token» на ровном месте. Поэтому перед запросом
 * перечитываем токен из localStorage: если соседняя вкладка уже обновила его,
 * обновляться второй раз не нужно.
 *
 * Вторая: если обновиться всё-таки нельзя, это конец сессии, а не ошибка запроса.
 * Чистим токены и говорим об этом приложению — иначе человек смотрит на английскую
 * ошибку поверх пустого экрана и не понимает, что делать.
 */
async function tryRefresh(previousAccess: string | null): Promise<void> {
  // соседняя вкладка успела обновить токен — наш запрос просто повторится с новым
  if (tokens.access && tokens.access !== previousAccess) return;
  if (!tokens.refresh) return signOut();

  if (!refreshing) {
    const used = tokens.refresh;
    refreshing = rawRequest<AuthResult>('POST', '/auth/refresh', { refreshToken: used }, false)
      .then((r) => {
        tokens.set(r.accessToken, r.refreshToken);
      })
      .catch((e) => {
        // пока мы ходили за новым токеном, вкладка-сосед могла всё сделать за нас
        if (tokens.refresh && tokens.refresh !== used) return;
        signOut();
        throw e;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

function signOut(): never {
  tokens.clear();
  window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
  throw new ApiError('UNAUTHORIZED', 'Сессия истекла — войдите снова');
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
  // Таймер сам ставит и снимает статус «занят задачей». Панель об этом узнавала
  // только после перезагрузки страницы — под именем месяцами висело «Фокус не задан»,
  // хотя человек работал.
  if (/\/timer\/(start|stop)$/.test(path)) window.dispatchEvent(new Event('teamcrm:focus-changed'));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Запрос с авто-обновлением access-токена при 401 и с пережиданием выкладки.
 *
 * Пока обновляется сервер, API недоступен несколько секунд, и человек видел
 * «Bad response (502)» посреди работы. Чтение повторяем сами — дважды, с паузой:
 * к этому моменту новый контейнер обычно уже отвечает.
 *
 * Изменения (POST/PATCH/DELETE) НЕ повторяем: 502 бывает и после того, как запрос
 * уже дошёл до сервера, и повтор завёл бы вторую задачу. Здесь честнее сказать
 * человеку «сервер обновляется, повторите», чем молча сделать что-то дважды.
 */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  // запоминаем, с каким токеном шли: по нему видно, обновил ли его кто-то параллельно
  const access = tokens.access;
  const retries = method === 'GET' ? 2 : 0;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await rawRequest<T>(method, path, body);
      announceTaskChange(method, path);
      return res;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'UNAUTHORIZED') {
        await tryRefresh(access);
        const res = await rawRequest<T>(method, path, body);
        announceTaskChange(method, path);
        return res;
      }
      if (e instanceof ApiError && e.code === 'UNAVAILABLE' && attempt < retries) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (e instanceof ApiError && e.code === 'UNAVAILABLE') {
        throw new ApiError('UNAVAILABLE', 'Сервер обновляется — повторите действие через несколько секунд');
      }
      throw e;
    }
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
  /**
   * Переписка задачи: по умолчанию последние сто сообщений — разговор читают с конца.
   * `all` поднимает всю: за ней ходит кнопка «показать предыдущие» и переход к
   * старому сообщению из истории задачи.
   */
  listComments: (taskId: string, all = false) =>
    request<any[]>('GET', `/tasks/${taskId}/comments${all ? '?all=1' : ''}`),
  addComment: (taskId: string, body: string, isClientVisible?: boolean, replyToId?: string, replyExcerpt?: string) =>
    request<any>('POST', `/tasks/${taskId}/comments`, { body, isClientVisible, replyToId, replyExcerpt }),
  /** Реакция на сообщение: повторное нажатие снимает свою. */
  reactToComment: (taskId: string, commentId: string, emoji: string) =>
    request<{ ok: true }>('POST', `/tasks/${taskId}/comments/${commentId}/reactions`, { emoji }),
  /** Правка своего сообщения: написанное, в отличие от сказанного, можно поправить. */
  editComment: (taskId: string, cid: string, body: string) =>
    request<any>('PATCH', `/tasks/${taskId}/comments/${cid}`, { body }),
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
  /**
   * «Проверить задачу с помощью ИИ»: сверяет постановку с тем, что показали в задаче.
   *
   * Ответ ложится в переписку задачи, поэтому наверх возвращаем только вердикт —
   * им подсвечиваем кнопку и показываем короткое сообщение.
   */
  reviewTask: (taskId: string) => request<{
    verdict: 'done' | 'partial' | 'not_done' | 'cannot_check';
    summary: string;
    body: string;
  }>('POST', `/tasks/${taskId}/review`),
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
  updateProfile: (b: { fullName?: string; phone?: string; timezone?: string; locale?: string; radarStuckHours?: number | null; calendarBlockOverlap?: boolean; birthDate?: string | null }) =>
    request<any>('PATCH', '/me', b),
  changePassword: (b: { currentPassword: string; newPassword: string }) =>
    request<any>('POST', '/me/password', b),
  /**
   * Объединение похожих задач: подсказки ИИ, предпросмотр и само объединение.
   *
   * Поиск без `q` — рекомендации по похожести; с `q` — обычный поиск по названию,
   * номеру, проекту, исполнителю и постановщику.
   */
  taskMergeCandidates: (taskId: string, q?: string) => request<{
    items: {
      id: string; title: string; projectId: string; projectName: string | null;
      assigneeName: string | null; managerName: string | null; match: number; reason: string;
    }[];
    searched: boolean;
  }>('GET', `/tasks/${taskId}/merge/candidates${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  /**
   * «Возможно, такая задача уже есть» — проверка до создания.
   *
   * Ищет по набранному названию и описанию; пустой ответ — обычное дело и не ошибка.
   */
  taskDuplicates: (title: string, description?: string) => request<{
    items: {
      id: string; title: string; projectId: string; projectName: string | null;
      assigneeName: string | null; managerName: string | null; match: number; reason: string;
    }[];
  }>('GET', `/tasks/duplicates?title=${encodeURIComponent(title)}`
    + (description ? `&description=${encodeURIComponent(description.slice(0, 4000))}` : '')),
  taskMergePreview: (taskId: string, withId: string) => request<{
    primary: MergeSide; secondary: MergeSide;
    moves: { comments: number; files: number; checklist: number; participants: number; messages: number; meetings: number };
    differentProjects: boolean;
    suggestion: { title: string; description: string; checklist: string[]; byAi: boolean };
  }>('GET', `/tasks/${taskId}/merge/preview?with=${encodeURIComponent(withId)}`),
  mergeTasks: (taskId: string, body: {
    primaryId: string; secondaryId: string; title?: string; description?: string; checklist?: string[];
  }) => request<{ taskId: string; projectId: string; mergedId: string }>('POST', `/tasks/${taskId}/merge`, body),

  /** Личное меню: порядок и скрытые разделы. Настройка человека, а не браузера. */
  /** Настройки интерфейса сливаются на сервере: присылайте только свой кусок. */
  saveUiPrefs: (prefs: { order?: string[]; hidden?: string[]; chatBar?: { expanded?: boolean; width?: number }; chatSections?: { order?: string[]; collapsed?: string[] }; anthill?: { memoryAuto?: boolean } }) =>
    request<{ uiPrefs: any }>('PUT', '/me/ui-prefs', { prefs }),
  /** Присутствие людей компании — для Chat Bar: в сети, когда видели, что о себе поставили. */
  presence: () => request<{ userId: string; online: boolean; lastSeenAt: string | null; status: 'busy' | 'away' | null }[]>('GET', '/presence'),
  setPresenceStatus: (status: 'busy' | 'away' | null) =>
    request<{ status: 'busy' | 'away' | null }>('PUT', '/presence/status', { status }),

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
    requiresApproval?: boolean; checklist?: string[];
  }) =>
    request<Task>('POST', '/tasks', b),
  updateTask: (id: string, b: Partial<{
    title: string; description: string; isBlocked: boolean; priority: string;
    managerId: string | null; assigneeId: string | null;
  }>) =>
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
  /*
    ───── AnthillBot (ТЗ-6) ─────
    Сессии, вопрос потоком, действия с подтверждением, оценка.
  */
  anthillSessions: () => request<AnthillSession[]>('GET', '/anthill/sessions'),
  anthillStart: (context?: AnthillContext | null) => request<{ id: string }>('POST', '/anthill/sessions', context ? { context } : {}),
  anthillMessages: (id: string) => request<AnthillMessage[]>('GET', `/anthill/sessions/${id}/messages`),
  anthillDelete: (id: string) => request<{ deleted: boolean }>('DELETE', `/anthill/sessions/${id}`),
  anthillConfirm: (actionId: string) => request<{ status: string; text: string; output: Record<string, unknown>; sources: AnthillSource[]; canUndo: boolean }>('POST', `/anthill/actions/${actionId}/confirm`, {}),
  anthillReject: (actionId: string) => request<{ status: string }>('POST', `/anthill/actions/${actionId}/reject`, {}),
  anthillEdit: (actionId: string, patch: Record<string, string>) =>
    request<{ id: string; preview: string; values: Record<string, string> }>('POST', `/anthill/actions/${actionId}/edit`, { patch }),
  anthillUndo: (actionId: string) => request<{ status: string; text: string }>('POST', `/anthill/actions/${actionId}/undo`, {}),
  /* Память агента (ТЗ-6, разд. 20–21): человек видит, что о нём запомнили, и правит это. */
  anthillMemories: () => request<AnthillMemory[]>('GET', '/anthill/memories'),
  anthillRemember: (type: 'preference' | 'topic', title: string, content: string) =>
    request<AnthillMemory>('POST', '/anthill/memories', { type, title, content }),
  anthillEditMemory: (id: string, title: string, content: string) =>
    request<AnthillMemory>('PATCH', `/anthill/memories/${id}`, { title, content }),
  anthillForget: (id: string) => request<{ deleted: boolean }>('DELETE', `/anthill/memories/${id}`),

  /* Регулярные задачи агента (разд. 15). */
  anthillSchedules: () => request<AnthillSchedule[]>('GET', '/anthill/schedules'),
  anthillAddSchedule: (i: { title: string; instruction: string; schedule: string }) =>
    request<AnthillSchedule>('POST', '/anthill/schedules', i),
  anthillPatchSchedule: (id: string, patch: { title?: string; instruction?: string; schedule?: string; status?: 'active' | 'paused' | 'done' }) =>
    request<AnthillSchedule>('PATCH', `/anthill/schedules/${id}`, patch),
  anthillDeleteSchedule: (id: string) => request<{ deleted: boolean }>('DELETE', `/anthill/schedules/${id}`),

  anthillFeedback: (messageId: string, vote: 1 | -1, reason?: string, comment?: string) =>
    request<{ ok: true }>('POST', `/anthill/messages/${messageId}/feedback`, { vote, reason, comment }),
  /**
   * Вопрос потоком (SSE). Возвращает функцию остановки: разрыв соединения = «Остановить»,
   * набранная часть остаётся у человека на экране и в истории.
   */
  anthillAsk: (
    id: string, question: string, context: AnthillContext | null,
    on: {
      onStatus?: (t: string) => void; onDelta?: (t: string) => void; onSources?: (s: AnthillSource[]) => void;
      onAction?: (a: { id: string; tool: string; preview: string; fields: AnthillField[]; values: Record<string, string> }) => void;
      onDone?: (d: { messageId: string }) => void; onError?: (m: string) => void;
    },
  ): { stop: () => void; finished: Promise<void> } => {
    const ctrl = new AbortController();
    const finished = (async () => {
      let res: Response;
      try {
        res = await fetch(`${BASE}/anthill/sessions/${id}/ask`, {
          method: 'POST', signal: ctrl.signal,
          headers: { 'Content-Type': 'application/json', ...(tokens.access ? { Authorization: `Bearer ${tokens.access}` } : {}) },
          body: JSON.stringify({ question, context: context ?? undefined }),
        });
      } catch (e) { if ((e as Error).name !== 'AbortError') on.onError?.('Нет связи с сервером'); return; }
      if (!res.ok || !res.body) { on.onError?.('Не удалось получить ответ. Попробуйте снова.'); return; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      try {
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
            if (ev === 'status') on.onStatus?.(data.text);
            else if (ev === 'delta') on.onDelta?.(data.text);
            else if (ev === 'sources') on.onSources?.(data.sources ?? []);
            else if (ev === 'action') on.onAction?.(data.action);
            else if (ev === 'done') on.onDone?.(data);
            else if (ev === 'error') on.onError?.(data.text ?? data.message);
          }
        }
      } catch (e) { if ((e as Error).name !== 'AbortError') on.onError?.('Связь оборвалась'); }
    })();
    return { stop: () => ctrl.abort(), finished };
  },

  /** Расход ИИ: токены, деньги, по дням и по возможностям (включая незапускавшиеся). */
  /** Проверить выбранную модель настоящим вызовом: отвечает ли она и кто ответил. */
  aiCheckModel: () => request<{
    requested: string; answered: string | null; ok: boolean; fallback: boolean; error: string | null;
  }>('POST', '/ai/settings/check', {}),

  aiUsage: (days = 30) => request<any>('GET', `/ai/usage?days=${days}`),
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
  // Открытая доска едет вместе с командой: задачу почти всегда ставят в проект,
  // на который человек в этот момент смотрит.
  nlParse: (text: string, currentProjectId?: string | null) =>
    request<any>('POST', '/nl/parse', currentProjectId ? { text, currentProjectId } : { text }),
  nlApply: (body: { intent: string; task?: any; deal?: any }) => request<any>('POST', '/nl/apply', body),
  /** Голосовая команда: аудио-запись → Whisper → распознанный текст. */
  /**
   * Длинная надиктовка: отправляем запись и следим за обработкой.
   *
   * Не ждём ответа с задачами в том же запросе — расшифровка десяти минут звука идёт
   * минутами и упирается в любой таймаут по пути. Сервер сохраняет аудио и отвечает
   * сразу, а дальше мы спрашиваем, как дела.
   */
  voiceStart: async (blob: Blob, currentProjectId?: string | null): Promise<VoiceJob> => {
    const fd = new FormData();
    fd.append('audio', blob, 'voice.webm');
    if (currentProjectId) fd.append('currentProjectId', String(currentProjectId));
    const res = await fetch(`${BASE}/nl/voice`, {
      method: 'POST',
      headers: tokens.access ? { Authorization: `Bearer ${tokens.access}` } : {},
      body: fd,
    });
    const env = await res.json().catch(() => ({ ok: false }));
    if (!env.ok) {
      // 413 приходит от прокси без нашего конверта — переводим на человеческий
      const message = res.status === 413
        ? 'Запись слишком большая. Попробуйте продиктовать частями.'
        : env.error?.message ?? 'Не удалось отправить запись';
      throw new ApiError(env.error?.code ?? 'INTERNAL', message);
    }
    return env.data;
  },
  voiceStatus: (id: string) => request<VoiceJob>('GET', `/nl/voice/${id}`),
  voiceRetry: (id: string, currentProjectId?: string | null) =>
    request<VoiceJob>('POST', `/nl/voice/${id}/retry`, currentProjectId ? { currentProjectId } : {}),

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
  // Спросить секретаря о текущих делах обычным языком
  // «Сделаю сегодня» — ответ делом; по нему считается отклик на напоминания
  actedPing: (id: string) => request<{ done: true }>('POST', `/assistant/pings/${id}/acted`),
  assistantReaction: () => request<{ rate: number; sent: number; muted: string[] }>('GET', '/assistant/reaction'),

  assistantAsk: (question: string) =>
    request<{ kind: string; answer: string }>('POST', '/assistant/ask', { question }),
  assistantEvening: () =>
    request<{ text: string; facts: any }>('GET', '/assistant/evening/preview'),

  // Дыры в данных: задачи без исполнителя и срока — с готовыми предложениями
  assistantGaps: () => request<{
    noAssignee: { taskId: string; title: string; projectId: string; projectName: string;
      assignee?: { userId: string; fullName: string; reason: string } }[];
    noDeadline: { taskId: string; title: string; projectId: string; projectName: string;
      deadline?: { date: string; reason: string } }[];
    counts: { noAssignee: number; noDeadline: number };
  }>('GET', '/assistant/gaps'),
  applyGap: (body: { taskId: string; assigneeId?: string; deadline?: string; confirmOverload?: boolean }) =>
    request<any>('POST', '/assistant/gaps/apply', body),
  skipGap: (taskId: string, kind: 'assignee' | 'deadline') =>
    request<{ skipped: true }>('POST', '/assistant/gaps/skip', { taskId, kind }),

  telegramStatus: () => request<{ linked: boolean; botUrl: string | null }>('GET', '/me/telegram/status'),
  telegramUnlink: () => request<{ ok: true }>('DELETE', '/me/telegram/link'),
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
  /** Кому доверено публиковать новости компании. Право на ДОЛЖНОСТИ — см. ленту. */
  setPositionNewsRight: (id: string, canPostNews: boolean) =>
    request<any>('PATCH', `/positions/${id}/news-right`, { canPostNews }),
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
  sendChatMessage: (
    chatId: string, body: string,
    thread?: { rootId?: string; alsoInChannel?: boolean },
    mentionIds?: string[],
  ) =>
    request<any>('POST', `/chats/${chatId}/messages`, {
      body, threadRootId: thread?.rootId, alsoInChannel: thread?.alsoInChannel, mentionIds,
    }),
  markChatRead: (chatId: string) => request<any>('POST', `/chats/${chatId}/read`),
  chatMembers: (chatId: string) => request<{
    canManage: boolean; createdBy: string | null; members: { userId: string; fullName: string }[];
  }>('GET', `/chats/${chatId}/members`),
  addChatMembers: (chatId: string, userIds: string[]) => request<{ added: number }>('POST', `/chats/${chatId}/members`, { userIds }),
  removeChatMember: (chatId: string, userId: string) => request<any>('DELETE', `/chats/${chatId}/members/${userId}`),
  renameChat: (chatId: string, title: string) => request<{ title: string }>('PATCH', `/chats/${chatId}`, { title }),
  leaveChat: (chatId: string) => request<any>('POST', `/chats/${chatId}/leave`),
  /**
   * Сайдбар чата (ТЗ-5, этап 2): сведения и участники по ролям одним запросом,
   * материалы по вкладкам, своё сохранённое в этом чате, журнал действий.
   */
  chatInfo: (chatId: string) => request<ChatInfo>('GET', `/chats/${chatId}/info`),
  chatMaterials: (chatId: string, kind: 'media' | 'voice' | 'docs' | 'files' | 'links') =>
    request<{ items: MaterialItem[] }>('GET', `/chats/${chatId}/materials?kind=${kind}`),
  chatSavedIn: (chatId: string) => request<any[]>('GET', `/chats/${chatId}/saved`),
  chatAudit: (chatId: string) => request<{ id: string; action: string; detail: Record<string, unknown>; created_at: string; actor_name: string | null }[]>('GET', `/chats/${chatId}/audit`),
  setChatMemberRole: (chatId: string, userId: string, role: 'admin' | 'member') =>
    request<{ role: string }>('PATCH', `/chats/${chatId}/members/${userId}/role`, { role }),
  /** Задачи чата: выросшие из сообщений и отправленные карточкой (ТЗ-5, этап 3). */
  chatTasks: (chatId: string) => request<{
    total: number; projectId: string | null;
    items: { id: string; title: string; status: string; closed: boolean; deadlineAt: string | null; projectId: string; assigneeName: string | null; relation: string }[];
  }>('GET', `/chats/${chatId}/tasks`),
  /** Миты чата: созвоны отсюда и связанные встречи — с итогом, говорившими и задачами (ТЗ-5, этап 4). */
  chatMeetings: (chatId: string) => request<{
    id: string; title: string; at: string; durationSec: number | null; status: string; summary: string | null;
    tasksCreated: number; participants: string[]; projectId: string | null;
  }[]>('GET', `/chats/${chatId}/meetings`),
  /** «+ Отправить текущую задачу / проект» карточкой в чат. */
  chatShare: (chatId: string, entityType: 'task' | 'project', entityId: string) =>
    request<any>('POST', `/chats/${chatId}/share`, { entityType, entityId }),
  /** Задача коротко — шапка окна чата задачи поверх CRM. */
  taskBrief: (taskId: string) => request<{
    id: string; title: string; projectId: string; projectName: string | null; status: string; closed: boolean;
    assigneeId: string | null; createdBy: string | null; participants: { user_id: string; role: string; full_name: string }[];
  }>('GET', `/tasks/${taskId}/brief`),
  /** Уведомления по чату: все · только упоминания · выключены (ТЗ-5, этап 5). */
  setChatNotify: (chatId: string, notify: 'all' | 'mentions' | 'none') =>
    request<{ notify: string }>('PUT', `/chats/${chatId}/notify`, { notify }),
  setChatDescription: (chatId: string, description: string) =>
    request<{ description: string | null }>('PATCH', `/chats/${chatId}/description`, { description }),
  deleteChatMessage: (chatId: string, messageId: string) => request<any>('DELETE', `/chats/${chatId}/messages/${messageId}`),
  /**
   * Клип в чат: голосовое сообщение или запись экрана.
   *
   * Расшифровка делается на сервере и ложится в тело сообщения — иначе аудио и видео
   * становятся чёрной дырой: их не найдёт поиск и не разберёт помощник.
   */
  sendChatClip: async (chatId: string, blob: Blob, kind: 'voice' | 'screen') => {
    const fd = new FormData();
    const ext = kind === 'voice' ? 'webm' : 'webm';
    fd.append('file', blob, `${kind === 'voice' ? 'Голосовое' : 'Запись экрана'} ${new Date().toLocaleString('ru-RU')}.${ext}`);
    fd.append('kind', kind);
    const res = await fetch(`/api/chats/${chatId}/clip`, {
      method: 'POST', headers: tokens.access ? { Authorization: `Bearer ${tokens.access}` } : {}, body: fd,
    });
    const env = await res.json();
    if (!env.ok) throw new ApiError(env.error?.code ?? 'INTERNAL', env.error?.message ?? 'Запись не отправлена');
    return env.data;
  },

  /** Вопрос помощнику в чате: ответ ложится в ту же переписку, при всех. */
  askChatAi: (chatId: string, question: string) =>
    request<any>('POST', `/chats/${chatId}/ai`, { question }),
  /** Сводка непрочитанного в чате: «47 непрочитанных» — не ответ на вопрос «что там». */
  chatAiDigest: (chatId: string) =>
    request<{ text: string; messages: number }>('POST', `/chats/${chatId}/ai/digest`, {}),
  /** «Что я пропустил»: сводка по всем доступным чатам. */
  aiMissed: () => request<{ text: string; messages: number }>('POST', '/chats/ai/digest', {}),
  /** Поиск по переписке словами — только по тому, что доступно спрашивающему. */
  aiSearchChats: (query: string) => request<{
    answer: string;
    refs: { messageId: string; chatId: string; chat: string; author: string | null; at: string; text: string }[];
  }>('POST', '/chats/ai/search', { query }),

  /** Канал — общая тема: публичный виден всем, приватный как группа с названием темы. */
  createChannel: (b: { title: string; description?: string; isPrivate?: boolean; userIds?: string[] }) =>
    request<{ id: string; kind: string; title: string }>('POST', '/chats/channels', b),
  /** Витрина «Все каналы»: только публичные — приватные сюда не приходят вовсе. */
  listChannels: () => request<{
    id: string; title: string | null; description: string | null;
    members: number; joined: boolean; last_message_at: string | null;
  }[]>('GET', '/chats/channels'),
  joinChannel: (chatId: string) => request<{ id: string }>('POST', `/chats/${chatId}/join`, {}),
  /** Закрепить чат сверху списка или снять — порядок личный. */
  toggleChatFavorite: (chatId: string) => request<{ favorite: boolean }>('POST', `/chats/${chatId}/favorite`, {}),
  /** «Пометить как непрочитанное» — как в Telegram: вернуться к разговору позже. Снимается открытием чата. */
  markChatUnread: (chatId: string) => request<{ unread: boolean }>('POST', `/chats/${chatId}/unread`, {}),
  /** С этого сообщения и дальше — снова непрочитанное; чат покажет их число. Только для чужих сообщений. */
  markUnreadFromMessage: (chatId: string, messageId: string) =>
    request<{ unread: boolean }>('POST', `/chats/${chatId}/messages/${messageId}/unread`, {}),
  /**
   * Внешний чат: разговор с клиентом или подрядчиком по ссылке.
   *
   * Отдельный от внутренних намеренно: «клиент опять поменял требования» говорят во
   * внутреннем чате проекта, и уехать клиенту оно не может.
   */
  createExternalChat: (b: { title: string; clientId?: string; userIds?: string[] }) =>
    request<{ id: string; kind: string; title: string }>('POST', '/chats/external', b),

  /** Переписка глазами гостя: токен из ссылки, один-единственный разговор. */
  guestChatMessages: (token: string) =>
    rawRequest<any[]>('POST', '/meet/guest/chat/messages', { token }, false),
  guestChatSend: (token: string, body: string) =>
    rawRequest<any>('POST', '/meet/guest/chat/send', { token, body }, false),

  /** Чат с собой: ссылки и мысли на потом. Открывается один и тот же. */
  openSelfChat: () => request<{ id: string; kind: string; title: string }>('POST', '/chats/self', {}),

  /**
   * Задача из сообщения: сначала черновик (ИИ раскладывает фразу на постановку,
   * шаги и срок), потом создание — формулировку человек правит сам.
   */
  messageTaskDraft: (chatId: string, messageId: string) =>
    request<any>('POST', `/chats/${chatId}/messages/${messageId}/task/draft`, {}),
  createTaskFromMessage: (chatId: string, messageId: string, task: Record<string, unknown>) =>
    request<{ taskId: string; title: string; projectId: string }>('POST', `/chats/${chatId}/messages/${messageId}/task`, task),
  /**
   * Порядок досок — общий для компании.
   *
   * `saveProjectOrder` сохраняет перетаскивание, `setProjectDefault` помечает доску
   * основной (такие всегда первыми), `resetProjectOrder` возвращает понятный вид
   * после импорта: основные наверх, остальные по алфавиту.
   */
  saveProjectOrder: (ids: string[]) => request<{ saved: number }>('POST', '/projects/order', { ids }),
  resetProjectOrder: () => request<import('../types').Project[]>('POST', '/projects/order/default'),
  /** Ответственный за проект — показывается в шапке чата проекта; пусто — снять. */
  setProjectOwner: (id: string, userId: string | null) =>
    request<{ ownerUserId: string | null }>('POST', `/projects/${id}/owner`, { userId }),
  setProjectDefault: (id: string, isDefault: boolean) =>
    request<{ isDefault: boolean }>('POST', `/projects/${id}/default`, { isDefault }),
  /**
   * Поддержка: обращение — обычная задача владельцу в проекте поддержки.
   * Какой проект принимает обращения, выбирает руководитель в настройках проекта.
   */
  supportOverview: () => request<{
    project: { id: string; name: string } | null;
    tickets: { id: string; title: string; status: string; closed: boolean; createdAt: string; projectId: string; assigneeName: string | null }[];
  }>('GET', '/support'),
  supportCreate: (input: { title: string; description?: string }) =>
    request<{ id: string; projectId: string; title: string }>('POST', '/support', input),
  setSupportProject: (projectId: string, isSupport: boolean) =>
    request<{ isSupport: boolean }>('POST', `/support/project/${projectId}`, { isSupport }),
  /**
   * Доски по умолчанию внутри проекта: недостающие заводятся и встают в начало,
   * перед созданными вручную. Ничего не удаляется — свои колонки уезжают правее.
   */
  ensureDefaultColumns: (projectId: string) =>
    request<{ added: string[]; columns: { id: string; name: string }[] }>(
      'POST', `/projects/${projectId}/columns/default`),

  /**
   * Поиск по ВСЕМ чатам — как в мессенджерах: ищет буквы, а не смысл.
   *
   * Отличается от `chatAiSearch`: тот пересказывает найденное, а здесь нужно само
   * сообщение — человек помнит обрывок фразы и хочет увидеть её в разговоре.
   */
  searchChatMessages: (q: string) => request<{
    items: {
      messageId: string; chatId: string; chatTitle: string; chatKind: string;
      authorName: string | null; body: string; createdAt: string; threadRootId: string | null;
    }[];
  }>('GET', `/chats/search?q=${encodeURIComponent(q)}`),
  /** Окно сообщений вокруг найденного: увидеть реплику в разговоре, а не в пустоте. */
  chatMessagesAround: (chatId: string, messageId: string) =>
    request<any[]>('GET', `/chats/${chatId}/around/${messageId}`),

  /** Отложенные сообщения: написать сейчас, отправить в назначенное время. */
  scheduleChatMessage: (chatId: string, body: {
    body: string; sendAt: string; repeat?: 'none' | 'daily';
    rootId?: string; alsoInChannel?: boolean; mentionIds?: string[];
  }) =>
    request<Scheduled>('POST', `/chats/${chatId}/scheduled`, body),
  listScheduled: (chatId: string) => request<{ items: Scheduled[] }>('GET', `/chats/${chatId}/scheduled`),
  cancelScheduled: (id: string) => request<{ cancelled: boolean }>('DELETE', `/chats/scheduled/${id}`),
  /** «Отправить сейчас»: передумал ждать. */
  sendScheduledNow: (id: string) => request<{ sent: boolean }>('POST', `/chats/scheduled/${id}/send`),
  editScheduled: (id: string, body: string) => request<{ body: string }>('PATCH', `/chats/scheduled/${id}`, { body }),
  rescheduleMessage: (id: string, sendAt: string) =>
    request<{ sendAt: string }>('PATCH', `/chats/scheduled/${id}`, { sendAt }),

  /** Правка своего сообщения: помечается как изменённое, чужие править нельзя. */
  editMessage: (chatId: string, messageId: string, body: string) =>
    request<{ edited: boolean; body: string }>('PATCH', `/chats/${chatId}/messages/${messageId}`, { body }),
  deleteMessage: (chatId: string, messageId: string) =>
    request<{ deleted: boolean }>('DELETE', `/chats/${chatId}/messages/${messageId}`),
  /** Что за сущность стоит за чатом: проект, статус, сколько задач горит. */
  chatContext: (chatId: string) => request<{
    project_id: string | null; project_name: string | null; status: string | null;
    open_tasks: number; overdue: number; client_name: string | null;
  } | null>('GET', `/chats/${chatId}/context`),
  /** Откуда выросла задача: чат, автор и сама фраза. */
  taskSourceMessage: (taskId: string) => request<{
    message_id: string; chat_id: string; body: string; created_at: string;
    author_name: string | null; chat_kind: string; chat_title: string | null; project_name: string | null;
  } | null>('GET', `/chats/of-task/${taskId}`),

  /** Сохранить сообщение себе — переключатель. Раздел «Сохранённое» его и показывает. */
  saveChatMessage: (chatId: string, messageId: string) =>
    request<{ saved: boolean }>('POST', `/chats/${chatId}/messages/${messageId}/save`, {}),
  /** Напомнить об этом сообщении в назначенный момент. Момент считает клиент. */
  remindAboutMessage: (chatId: string, messageId: string, remindAt: string) =>
    request<{ remindAt: string }>('POST', `/chats/${chatId}/messages/${messageId}/remind`, { remindAt }),
  listSavedMessages: () => request<any[]>('GET', '/chats/saved'),
  listChatMentions: () => request<any[]>('GET', '/chats/mentions'),
  /** «Входящие»: позвали по имени, ответили в ветке, написали в чат — одной лентой. */
  chatInbox: () => request<{
    mentions: any[]; threads: any[]; chats: any[];
    counts: { mentions: number; threads: number; chats: number };
  }>('GET', '/chats/inbox'),

  /** Реакция на сообщение чата — переключатель: повторное нажатие снимает свою. */
  reactToChatMessage: (chatId: string, messageId: string, emoji: string) =>
    request<{ ok: true }>('POST', `/chats/${chatId}/messages/${messageId}/reactions`, { emoji }),
  /** Закрепить сообщение в шапке чата или снять закрепление. */
  pinChatMessage: (chatId: string, messageId: string, pinned: boolean) =>
    request<{ pinned: boolean }>('POST', `/chats/${chatId}/messages/${messageId}/pin`, { pinned }),
  chatPinned: (chatId: string) => request<any[]>('GET', `/chats/${chatId}/pinned`),

  /** Ветка обсуждения: корневое сообщение и ответы. Открытие помечает её прочитанной. */
  chatThread: (chatId: string, rootId: string) =>
    request<any[]>('GET', `/chats/${chatId}/threads/${rootId}`),
  /** Мои ветки: где я начал разговор или отвечал, с числом новых ответов. */
  myThreads: () => request<any[]>('GET', '/chats/threads'),

  /**
   * Файлы сообщением: несколько снимков — ОДНО сообщение, как в мессенджерах.
   *
   * Принимает и один файл, и пачку: отдельного метода на «один» не заводим, чтобы
   * два пути отправки не разошлись в мелочах.
   */
  sendChatFile: async (chatId: string, file: File | File[], body: string, thread?: { rootId?: string; alsoInChannel?: boolean }) => {
    const fd = new FormData();
    for (const f of Array.isArray(file) ? file : [file]) fd.append('files', f);
    if (thread?.rootId) fd.append('threadRootId', thread.rootId);
    if (thread?.alsoInChannel) fd.append('alsoInChannel', 'true');
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
  /** chatId — чат, из которого звонят: туда после разбора вернётся карточка с итогом. */
  startCall: (projectId?: string, withAi = false, chatId?: string) =>
    request<{ id: string; projectId: string | null; aiEnabled: boolean }>('POST', '/media/rooms', { projectId, withAi, chatId }),

  // лента компании: сообщения и объявления
  /**
   * Лента компании, постранично. `canPost` и номера страниц считает СЕРВЕР: правило
   * «кто публикует» одно на всю систему, а число страниц на клиенте пришлось бы гадать.
   */
  feedList: (page = 1) =>
    request<{ items: any[]; canPost: boolean; total: number; page: number; pages: number }>(
      'GET', `/feed?page=${page}`),
  feedUnread: () => request<{ items: any[]; count: number }>('GET', '/feed/unread'),
  /** Правая колонка новостей: объявления, свежие новости, дни рождения, новички. */
  feedSidebar: () => request<{
    announcements: { id: string; body: string; createdAt: string; isRead: boolean }[];
    latest: { id: string; body: string; createdAt: string; authorName: string | null }[];
    birthdays: { userId: string; fullName: string; avatarUrl: string | null; date: string; inDays: number }[];
    newcomers: { userId: string; fullName: string; avatarUrl: string | null; positionName: string | null; joinedAt: string }[];
  }>('GET', '/feed/sidebar'),
  feedCreate: (b: { body: string; isAnnouncement?: boolean; activeUntil?: string; groupIds?: string[]; mentionIds?: string[] }) =>
    request<any>('POST', '/feed', b),
  /** Вложение прикладывается к УЖЕ опубликованному посту: сорвётся загрузка — текст не пропадёт. */
  feedAttach: async (postId: string, file: File) => {
    const fd = new FormData(); fd.append('file', file);
    const res = await fetch(`/api/feed/${postId}/files`, {
      method: 'POST',
      headers: tokens.access ? { Authorization: `Bearer ${tokens.access}` } : {},
      body: fd,
    });
    const env = await res.json();
    if (!env.ok) throw new ApiError(env.error?.code ?? 'INTERNAL', env.error?.message ?? 'Не удалось приложить файл');
    return env.data;
  },
  feedRead: (id: string) => request<any>('POST', `/feed/${id}/read`),

  // смарт-пинги ассистента
  assistantMode: () =>
    request<{ mode: AssistantMode; autoTasks: boolean; maintenance: boolean }>('GET', '/assistant/mode'),
  setAssistantMode: (mode: AssistantMode) =>
    request<{ mode: AssistantMode; autoTasks: boolean; maintenance: boolean }>('PUT', '/assistant/mode', { mode }),
  assistantPings: () => request<Ping[]>('GET', '/assistant/pings'),
  // уборка брошенного (Zero-Maintenance)
  maintenanceList: () => request<Proposal[]>('GET', '/assistant/maintenance'),
  applyMaintenance: (id: string) => request<any>('POST', `/assistant/maintenance/${id}/apply`),
  dismissMaintenance: (id: string) => request<any>('POST', `/assistant/maintenance/${id}/dismiss`),
  undoMaintenance: (id: string) => request<any>('POST', `/assistant/maintenance/${id}/undo`),
  setMaintenanceEnabled: (enabled: boolean) =>
    request<{ maintenance: boolean }>('PUT', '/assistant/maintenance-enabled', { enabled }),

  // модератор встреч
  assistantAgendas: () => request<Agenda[]>('GET', '/assistant/agendas'),
  assistantAgenda: (eventId: string) => request<Agenda & { facts: unknown }>('GET', `/assistant/agendas/${eventId}`),
  setMeetingAutoTasks: (enabled: boolean) =>
    request<{ autoTasks: boolean }>('PUT', '/assistant/meeting-tasks', { enabled }),
  assistantProposed: () => request<Ping[]>('GET', '/assistant/pings/proposed'),
  sendPing: (id: string) => request<any>('POST', `/assistant/pings/${id}/send`),
  dismissPing: (id: string) => request<any>('POST', `/assistant/pings/${id}/dismiss`),
  feedReaders: (id: string) =>
    request<{ read: { fullName: string }[]; pending: { fullName: string }[] }>('GET', `/feed/${id}/readers`),
  /**
   * Комментарии новости: последние десять. `before` — идентификатор самого верхнего
   * показанного, им поднимают предыдущие: обсуждение читают с конца, а не с начала.
   */
  feedComments: (id: string, before?: string) =>
    request<{ items: any[]; total: number; hasMore: boolean }>(
      'GET', `/feed/${id}/comments${before ? `?before=${before}` : ''}`),
  feedComment: (id: string, body: string, mentionIds?: string[]) =>
    request<{ items: any[]; total: number; hasMore: boolean }>('POST', `/feed/${id}/comments`, { body, mentionIds }),
  feedPin: (id: string, pinned: boolean) => request<any>('POST', `/feed/${id}/pin`, { pinned }),
  feedDelete: (id: string) => request<any>('DELETE', `/feed/${id}`),

  // календарь: события людей и компании
  calendarRange: (from: string, to: string, withTasks = true) =>
    request<{
      events: any[]; external?: any[]; tasks: any[];
      work: { workStart: string; workEnd: string; weekendDays: number[]; holidays: string[] };
    }>('GET', `/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&tasks=${withTasks ? '1' : '0'}`),
  /**
   * Синхронизация с внешним календарём — двумя обычными ссылками, без OAuth.
   * Наш календарь отдаём по секретному адресу, чужой читаем по «секретному адресу
   * в формате iCal» из настроек Google.
   */
  calendarLinks: () => request<CalendarLink[]>('GET', '/calendar/links'),
  calendarExportLink: (rotate = false) => request<CalendarLink>('POST', '/calendar/links/export', { rotate }),
  calendarAddImport: (url: string, title?: string) =>
    request<{ id: string; imported: number }>('POST', '/calendar/links/import', { url, title }),
  calendarSyncLink: (id: string) => request<{ synced: number }>('POST', `/calendar/links/${id}/sync`),
  calendarRemoveLink: (id: string) => request<{ removed: boolean }>('DELETE', `/calendar/links/${id}`),
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
  /** Надиктованная встреча → заполненный черновик события. `now` — местное время клиента. */
  nlParseEvent: (text: string, now: string) =>
    request<{
      title: string; description: string | null; startsAt: string | null; endsAt: string | null;
      allDay: boolean; location: string | null; participantIds: string[];
      /** Распознанная фраза — показываем человеку: он должен видеть, что услышала система. */
      source: string; warnings: string[];
    }>('POST', '/nl/parse-event', { text, now }),

  saveCalendarWork: (b: { workStart: string; workEnd: string; weekendDays: number[]; holidays: string[] }) =>
    request<any>('POST', '/calendar/work', b),

  // гостевой доступ в созвон по ссылке
  createGuestLink: (b: { roomId?: string; projectId?: string; label?: string; ttlHours?: number; chatId?: string }) =>
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
  /** Правка черновика ДО создания задачи — она переживает перезагрузку страницы. */
  updateMeetingDraft: (draftId: string, b: {
    title?: string; description?: string | null; assigneeId?: string | null; projectId?: string | null;
  }) => request<any>('POST', `/meetings/drafts/${draftId}`, b),
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

  /**
   * Реестр задач по всем проектам. Строку запроса собирает task-registry-view:
   * пустые фильтры отправлять нельзя — сервер отвечает на них 400.
   */
  taskRegistry: (query: string) =>
    request<{
      items: (Task & {
        project_name: string; column_name: string; assignee_name: string | null;
        manager_name: string | null; is_mine: boolean; overdue: boolean; unread: number;
      })[];
      total: number; page: number; pageSize: number; pages: number;
    }>('GET', `/tasks/registry?${query}`),
  /** Исполнители, встречающиеся в задачах, — для фильтра реестра. */
  taskRegistryAssignees: () =>
    request<{ id: string; full_name: string }[]>('GET', '/tasks/registry/assignees'),
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

  // Этап 4 — прогноз срока, назначение с проверкой перегруза, velocity
  assignTask: (id: string, b: { assigneeId: string; confirmOverload?: boolean; estimateHours?: number; deadlineAt?: string }) =>
    request<any>('POST', `/tasks/${id}/assign`, b),
  /** confirmTimeLoss — второе подтверждение для задачи с учтённым временем (только владельцу). */
  deleteTask: (id: string, confirmTimeLoss = false) =>
    request<{ deleted: true }>('DELETE', `/tasks/${id}${confirmTimeLoss ? '?confirmTimeLoss=1' : ''}`),
  /** Оценка и срок без назначения: задаче можно поставить дату, ещё не выбрав исполнителя. */
  /**
   * Спросить помощника по конкретной задаче: он уже знает постановку, участников,
   * чек-лист, сроки, обсуждение и итог встречи, из которой задача выросла.
   */
  askTaskAssistant: (taskId: string, question: string) => request<{
    answer: string;
    checklist: string[];
    suggestion: { field: string; value: string; label: string } | null;
  }>('POST', `/tasks/${taskId}/assistant`, { question }),
  /** Принять предложенный ИИ чек-лист — решение человека. */
  applyAssistantChecklist: (taskId: string, items: string[]) =>
    request<{ added: number }>('POST', `/tasks/${taskId}/assistant/checklist`, { items }),

  /** Кто ещё в задаче: соисполнители (делают работу) и наблюдатели (следят). */
  taskParticipants: (id: string) => request<{
    user_id: string; role: string; full_name: string; avatar_file_id: string | null;
  }[]>('GET', `/tasks/${id}/participants`),
  addTaskParticipant: (id: string, userId: string, role: 'co_assignee' | 'watcher') =>
    request<any[]>('POST', `/tasks/${id}/participants`, { userId, role }),
  removeTaskParticipant: (id: string, userId: string, role: 'co_assignee' | 'watcher') =>
    request<any[]>('DELETE', `/tasks/${id}/participants`, { userId, role }),

  /** Постановщик принял работу — задача завершается по-настоящему. */
  approveTask: (id: string) => request<Task>('POST', `/tasks/${id}/approve`, {}),
  /** Вернуть в работу: причина обязательна и попадает в историю задачи. */
  returnTask: (id: string, reason: string) => request<Task>('POST', `/tasks/${id}/return`, { reason }),
  /** Включить или снять согласование по задаче. */
  setTaskApproval: (id: string, enabled: boolean) =>
    request<Task>('POST', `/tasks/${id}/approval-required`, { enabled }),
  /** Из какой встречи выросла задача (null — задача заведена руками). */
  meetingOfTask: (taskId: string) =>
    request<{ meeting_id: string; title: string | null; happened_at: string | null } | null>(
      'GET', `/meetings/of-task/${taskId}`),

  /** Карточку открыли — изменения по ней перестают быть новыми. */
  markTaskRead: (id: string) => request<{ read: true }>('POST', `/tasks/${id}/read`, {}),

  /** Файл сообщением в чат задачи: скриншот показывают в разговоре, а не «см. вложение». */
  addCommentFile: async (taskId: string, file: File, body: string, replyToId?: string, replyExcerpt?: string) => {
    const fd = new FormData();
    fd.append('file', file);
    if (body) fd.append('body', body);
    if (replyToId) fd.append('replyToId', replyToId);
    if (replyExcerpt) fd.append('replyExcerpt', replyExcerpt);
    const res = await fetch(`/api/tasks/${taskId}/comments/file`, {
      method: 'POST', headers: tokens.access ? { Authorization: `Bearer ${tokens.access}` } : {}, body: fd,
    });
    const env = await res.json();
    if (!env.ok) throw new ApiError(env.error?.code ?? 'INTERNAL', env.error?.message ?? 'Файл не отправлен');
    return env.data;
  },

  saveTaskPlan: (id: string, b: { estimateHours?: number; deadlineAt?: string }) =>
    request<{ saved: true }>('POST', `/tasks/${id}/plan`, b),
  /**
   * Повтор задачи. Расписание живёт при задаче-образце: «повторять еженедельно» —
   * свойство этой задачи, и искать его человек будет в её карточке.
   */
  taskRecurrence: (id: string) => request<TaskRecurrence | null>('GET', `/tasks/${id}/recurrence`),
  setTaskRecurrence: (id: string, b: {
    freq: 'daily' | 'weekly' | 'monthly' | 'days';
    weekdays?: number[];
    monthday?: number;
    intervalDays?: number;
    atTime: string;
    tz?: string;
  }) => request<TaskRecurrence>('PUT', `/tasks/${id}/recurrence`, b),
  clearTaskRecurrence: (id: string) => request<{ cleared: boolean }>('DELETE', `/tasks/${id}/recurrence`),
  /**
   * Импорт задач из файла (CSV/Excel) — переезд с чужой системы.
   *
   * Два шага и оба обязательны: предпросмотр (что в файле и куда поедут колонки) и
   * только потом запись. Файл между шагами лежит на сервере — второй раз его не гоняем.
   */
  /**
   * Trello — слой 2 переезда. Доступ по паре «ключ + токен»: OAuth-приложение для
   * переноса своих досок не нужно и только добавило бы ожидание администратора.
   */
  trelloConnect: (apiKey: string, token: string, label?: string) =>
    request<any>('POST', '/integrations/trello/connections', { apiKey, token, label }),
  trelloConnections: () => request<any[]>('GET', '/integrations/trello/connections'),
  trelloDisconnect: (cid: string) => request<any>('DELETE', `/integrations/trello/connections/${cid}`),
  trelloBoards: (cid: string) =>
    request<{ id: string; name: string; closed: boolean; url: string | null }[]>('GET', `/integrations/trello/connections/${cid}/boards`),
  trelloImport: (cid: string, boardIds: string[]) =>
    request<{ runId: string }>('POST', `/integrations/trello/connections/${cid}/import`, { boardIds }),
  trelloRun: (runId: string) => request<any>('GET', `/integrations/trello/runs/${runId}`),
  trelloUnmatched: (cid: string) =>
    request<{ total: number; items: { externalId: string; name: string }[] }>('GET', `/integrations/trello/connections/${cid}/unmatched-users`),
  trelloMapUser: (cid: string, externalUserId: string, localUserId: string) =>
    request<any>('POST', `/integrations/trello/connections/${cid}/user-map`, { externalUserId, localUserId }),
  /**
   * Notion — слой 3 переезда. Токен внутренней интеграции; доступ к каждой базе
   * человек открывает в самом Notion через «Connections» (об этом сказано в панели).
   */
  notionConnect: (token: string, label?: string) =>
    request<any>('POST', '/integrations/notion/connections', { token, label }),
  notionConnections: () => request<any[]>('GET', '/integrations/notion/connections'),
  notionDisconnect: (cid: string) => request<any>('DELETE', `/integrations/notion/connections/${cid}`),
  notionDatabases: (cid: string) =>
    request<{ items: { id: string; name: string; statusProperty: string | null }[]; hint: string | null }>(
      'GET', `/integrations/notion/connections/${cid}/databases`),
  notionImport: (cid: string, databaseIds: string[]) =>
    request<{ runId: string }>('POST', `/integrations/notion/connections/${cid}/import`, { databaseIds }),
  notionRun: (runId: string) => request<any>('GET', `/integrations/notion/runs/${runId}`),
  notionUnmatched: (cid: string) =>
    request<{ total: number; items: { externalId: string; name: string; email: string }[] }>(
      'GET', `/integrations/notion/connections/${cid}/unmatched-users`),
  notionMapUser: (cid: string, externalUserId: string, localUserId: string) =>
    request<any>('POST', `/integrations/notion/connections/${cid}/user-map`, { externalUserId, localUserId }),
  /**
   * Google-документы — слой 4 переезда (scan и status объявлены выше, рядом с базой
   * знаний). Без OAuth: читаем то, что открыто «по ссылке». Граница честная —
   * закрытый документ попадёт в список с причиной, а не молча пропадёт.
   */
  gdocsList: () => request<any[]>('GET', '/integrations/gdocs/list'),
  gdocsAddLinks: (text: string, projectId?: string) =>
    request<{ added: number; skipped: number }>('POST', '/integrations/gdocs/links', { text, projectId }),
  importFields: () => request<{ key: string; label: string; hint: string }[]>('GET', '/integrations/file/fields'),
  importPreview: async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/integrations/file/preview', {
      method: 'POST',
      headers: tokens.access ? { Authorization: `Bearer ${tokens.access}` } : {},
      body: fd,
    });
    const env = await res.json();
    if (!env.ok) throw new ApiError(env.error?.code ?? 'INTERNAL', env.error?.message ?? 'Файл не прочитался');
    return env.data as ImportPreview;
  },
  importRun: (b: { token: string; mapping: Record<string, number>; projectId?: string; newProjectName?: string }) =>
    request<ImportStats>('POST', '/integrations/file/run', b),
  getForecast: (id: string) => request<any>('GET', `/tasks/${id}/forecast`),
  getVelocity: (userId: string) => request<any>('GET', `/users/${userId}/velocity`),
  getLoad: (userId: string) => request<any>('GET', `/users/${userId}/load`),
};

/** Сведения о чате для сайдбара. */
export interface ChatInfo {
  chat: {
    id: string; kind: string; title: string | null; description: string | null;
    isPrivate: boolean; isExternal: boolean;
    projectId: string | null; projectName: string | null;
    clientId: string | null; clientName: string | null;
    createdAt: string; createdBy: string | null; createdByName: string | null;
  };
  members: ChatMember[];
  /** Внешние участники по ссылке — без учётки, только имена. */
  guests: string[];
  me: { role: string | null; canManage: boolean; notify: 'all' | 'mentions' | 'none' };
  counts: { media: number; voice: number; docs: number; files: number; links: number; pinned: number };
}
export interface ChatMember {
  userId: string; fullName: string; avatarUrl: string | null;
  role: 'owner' | 'admin' | 'member' | 'external' | string;
  online: boolean; lastSeenAt: string | null; status: 'busy' | 'away' | null;
}
export interface MaterialItem {
  messageId: string; fileId?: string; name?: string; mime?: string; size?: number;
  url?: string; authorName: string | null; createdAt: string;
}

/** AnthillBot: с чем открыт разговор. */
export interface AnthillContext { type: 'task' | 'project' | 'chat' | 'meeting'; id: string; title?: string }
export interface AnthillSource { kind: 'task' | 'message' | 'meeting' | 'project' | 'chat'; id: string; title: string; url: string }
export interface AnthillSession { id: string; title: string; messages: number; updatedAt: string; context: { type: string; id: string } | null }
/** Поле карточки действия: состав задаёт инструмент на сервере. */
export interface AnthillField { key: string; label: string; type: 'text' | 'multiline' | 'date' | 'datetime' | string }
export interface AnthillAction {
  id: string;
  tool: string;
  status: string;
  output: Record<string, unknown> | null;
  /** Что можно поправить до «Создать»; пусто — карточка уже обработана. */
  fields: AnthillField[];
  values: Record<string, string>;
}
/** Что агент помнит о человеке: предпочтение (как работать) или рабочая тема. */
export interface AnthillMemory {
  id: string; type: 'preference' | 'topic' | string; title: string; content: string;
  /** auto — подметил сам, manual — попросили запомнить. */
  source: string; updatedAt: string;
}
export interface AnthillSchedule {
  id: string; title: string; instruction: string;
  schedule: { kind: string; time: string; weekday?: number; day?: number };
  /** Расписание по-русски: «каждый понедельник в 9:00». */
  label: string;
  status: 'active' | 'paused' | 'done' | string;
  nextRunAt: string | null; lastRunAt: string | null;
  lastResult: string | null; lastError: string | null;
  runs: number; sessionId: string | null;
}
export interface AnthillMessage {
  id: string; role: 'user' | 'assistant'; content: string; citations: AnthillSource[]; createdAt: string;
  action: AnthillAction | null;
}
