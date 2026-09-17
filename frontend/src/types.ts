export type RoleCode = 'owner' | 'manager' | 'member' | 'client';

export interface User {
  id: string;
  tenantId: string;
  email: string;
  fullName: string;
  role: RoleCode;
  isActive: boolean;
  /** Отделы и группы человека. Приходят из GET /users; в токене авторизации их нет. */
  groups?: { id: string; name: string; kind: string }[];
  /** Путь к аватару (`/api/files/:id`) — файл лежит за авторизацией, тянется через Avatar. */
  avatarUrl?: string | null;
  /** Личное меню: порядок пунктов и скрытые разделы; Chat Bar. Живёт у человека, не в браузере. */
  uiPrefs?: {
    order?: string[]; hidden?: string[];
    chatBar?: { expanded?: boolean; width?: number };
    /** Секции списка чатов: порядок и свёрнутые (ТЗ-5, раздел 38). */
    chatSections?: { order?: string[]; collapsed?: string[] };
    /** AnthillBot: собирать ли память самому (ТЗ-6, разд. 21). */
    anthill?: { memoryAuto?: boolean };
  };
}

export interface OrgRef {
  tenantId: string;
  name: string;
  role: string;
}

export interface AuthResult {
  user: User;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  organizations?: OrgRef[];
}

export interface Project {
  id: string;
  name: string;
  status: string;
  budget?: string | null;
  client_id?: string | null;
  deal_id?: string | null;
  origin?: string;
  origin_connection_id?: string | null;
  origin_label?: string | null;
  origin_portal?: string | null;
  /** Сколько нового в МОИХ задачах этого проекта — цифра рядом с ним в панели. */
  unread?: number;
  /** Основная доска компании: такие всегда первыми в списке. */
  is_default?: boolean;
  /** Место в общем порядке досок: меньше — выше. */
  sort_order?: number;
  /** Ответственный за проект: к нему идут с вопросами «что по проекту». */
  owner_user_id?: string | null;
  owner_name?: string | null;
  /** all — видят все сотрудники; members — только участники и руководство. */
  visibility?: string;
  is_support?: boolean;
}

export interface Task {
  id: string;
  project_id: string;
  column_id: string;
  position: number;
  title: string;
  description: string | null;
  assignee_id: string | null;
  assignee_name?: string | null;
  created_by?: string | null;
  manager_name?: string | null;
  /** Завершать только с согласия постановщика. */
  requires_approval?: boolean;
  /** none | pending — работа сдана и ждёт ответа постановщика. */
  approval_state?: string;
  status: string;
  is_blocked: boolean;
  agent_assigned?: boolean;
  cost_current?: string; // отсутствует в client-представлении (фича №9)
  risk_level?: 'green' | 'yellow' | 'red' | null; // светофор честных сроков (Этап 4)
  risk_pct?: string | null;
  predicted_finish_at?: string | null;
  estimate_hours?: string | null;
  deadline_at?: string | null;
  /**
   * Предложенный перенос срока («Сделал») — ждёт слова постановщика.
   *
   * Пока он здесь, deadline_at прежний: срок двигает решение человека, а не просьба.
   */
  deadline_shift_to?: string | null;
  deadline_shift_by?: string | null;
  /** личный план: на какой день человек взял задачу (не срок) */
  focus_date?: string | null;
  closed_at?: string | null;
  /** Задачу объединили с этой: она остаётся в списках, но помечена и закрыта. */
  merged_into_id?: string | null;
  priority?: string;
  labels?: { id: string; name: string; color: string }[];
  /**
   * Задача с повтором: образец или его копия. Значок на карточке отвечает на вопрос
   * «почему эта задача снова здесь» — без него копия выглядит дублем.
   */
  recurrence_id?: string | null;
  commentsCount?: number;
  attachmentsCount?: number;
  checklistTotal?: number;
  checklistDone?: number;
  /**
   * Сколько по задаче произошло НОВОГО лично для меня.
   *
   * Не путать с commentsCount и прочими: те показывают, сколько всего. Задача с тремя
   * вчерашними комментариями и задача с тремя сегодняшними выглядели одинаково —
   * ровно об этом и было замечание.
   */
  unread?: number;
}

export interface BoardColumn {
  id: string;
  name: string;
  position: number;
  tasks: Task[];
}

export interface Board {
  project: Project;
  columns: BoardColumn[];
}

export interface ActiveTimer {
  id: string;
  taskId: string;
  userId: string;
  startedAt: string;
  stoppedAt: string | null;
}

export interface Pnl {
  projectId: string;
  budget: number | null;
  costActual: number;
  marginActual: number | null;
  plannedMargin: number | null;
  marginDelta: number | null;
}

export interface CostOfWork {
  scope: 'task' | 'project';
  id: string;
  laborHours: number;
  laborCost: number;
  aiTokens: number;
  aiRuns: number;
  aiCost: number;
  total: number;
}

/** Текущий фокус сотрудника: над чем работает и до какого времени. */
export interface Focus {
  kind: 'deep' | 'call' | 'quick' | 'break' | 'task';
  note: string | null;
  taskId: string | null;
  until: string | null;
  userId?: string;
  userName?: string;
}

/** Строка журнала «AI Секретаря»: что система сделала за людей сама. */
export interface AiAction {
  id: string;
  kind: string;
  summary: string;
  saved_minutes: number;
  created_at: string;
  subject_type: string | null;
  subject_id: string | null;
  user_name: string | null;
}

/** Ответ поиска командной строки. Пусто во всех полях — значит правда ничего не нашлось. */
export interface SearchResults {
  query: string;
  tasks: { id: string; title: string; project_id: string; project_name: string; column_name: string; closed: boolean; assignee_name: string | null }[];
  projects: { id: string; name: string; status: string }[];
  chats: { id: string; title: string | null; kind: string }[];
  messages: { id: string; chat_id: string; chat_title: string | null; chat_kind: string; body: string; author_name: string | null; created_at: string }[];
  people: { id: string; full_name: string; email: string; role_code: string; position: string | null }[];
  docs: { id: string; title: string; source: string }[];
}

/** Находка смыслового поиска: кусок текста из архива и то, откуда он взят. */
export interface SemanticHit {
  sourceType: string;
  sourceId: string;
  title: string | null;
  projectId: string | null;
  projectName: string | null;
  snippet: string;
  score: number;
}

/** Согласование: то, что ждёт ответа человека и не является задачей. */
export interface Approval {
  id: string;
  kind: 'budget' | 'invoice' | 'vacation' | 'question' | 'other';
  subject: string;
  details: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  decision_note: string | null;
  due_at: string | null;
  created_at: string;
  author_name: string | null;
  approver_name: string | null;
  task_id: string | null;
  task_title: string | null;
  project_id: string | null;
}

/** Условия приёмки работы — общие для компании (меняет владелец). */
export interface GateSettings {
  checklist: boolean;
  comment: boolean;
  attachment: boolean;
}

/** Режим автономности ассистента: молчит / предлагает / напоминает сам. */
export type AssistantMode = 'off' | 'copilot' | 'autopilot';

/** Напоминание ассистента о зависшей работе. */
export interface Ping {
  id: string;
  kind: 'overdue' | 'due_soon' | 'stuck_review' | 'silent' | 'digest';
  taskId: string | null;
  projectId: string | null;
  text: string;
  status: 'proposed' | 'sent' | 'dismissed';
  createdAt: string;
  /** Кому адресовано — нужно постановщику в списке предложений. */
  toName: string | null;
  assigneeName: string | null;
}

/** Повестка встречи, собранная модератором за пять минут до начала. */
export interface Agenda {
  eventId: string;
  title: string;
  startsAt: string;
  body: string;
  meetRoomId: string | null;
}

/** Предложение ассистента прибрать брошенное. Выполняется только человеком и обратимо. */
export interface Proposal {
  id: string;
  kind: 'task_stale' | 'project_idle' | 'draft_stale';
  subjectType: 'task' | 'project' | 'draft';
  subjectId: string;
  title: string;
  text: string;
  status: 'pending' | 'applied' | 'dismissed' | 'reverted';
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

/*
  Служба заботы (ТЗ-8).

  Разговор, а не заявка: у него нет ни темы, ни категории, ни номера для человека.
  Статус приходит парой — сухой ярлык для кода и человеческая фраза для экрана.
*/
export interface SupportMessage {
  id: string;
  /** user — человек, agent — специалист, ai — AnthillBot, system — отметки разговора. */
  kind: 'user' | 'agent' | 'ai' | 'system';
  authorId: string | null;
  authorName: string | null;
  body: string;
  fileId: string | null;
  fileName: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  createdAt: string;
}

export interface SupportConversation {
  id: string;
  subject: string;
  status: string;
  statusText: string;
  priority: string;
  agentId: string | null;
  userId: string;
  createdAt: string;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  csat: number | null;
  reopens: number;
  participants: { user_id: string; role: string; full_name: string; joined_at: string }[];
  context: Record<string, unknown> | null;
  /** Предложенные действия: пока человек не разрешил, не сделано ничего. */
  actions: {
    id: string; action: string; preview: string;
    status: 'proposed' | 'done' | 'declined' | 'undone'; approved: boolean; createdAt: string;
  }[];
  messages: SupportMessage[];
}

export interface SupportDesk {
  conversation: SupportConversation | null;
  /** Открытый массовый сбой: о нём человек должен узнать раньше, чем напишет. */
  incident: { id: string; title: string; message: string } | null;
  history: {
    id: string; subject: string; status: string; statusText: string;
    agentName: string | null; messages: number; createdAt: string;
    closedAt: string | null; csat: number | null;
  }[];
  team: { userId: string; name: string; online: boolean; status: string | null; skills: string[] }[];
  /** Секунды до первого ответа или null — обещать нечего (ТЗ-8, разд. 6). */
  etaSeconds: number | null;
  isAgent: boolean;
}

export interface SupportQueueItem {
  id: string; subject: string; status: string; statusText: string;
  userName: string; agentName: string | null; waitingSince: string;
  lastAt: string | null; priority: string;
}

/** Безопасный технический контекст: только то, что видно на экране (разд. 15–16). */
export interface SupportContextInput {
  url?: string;
  route?: string;
  entityType?: string;
  entityId?: string;
  browser?: string;
  os?: string;
  appVersion?: string;
  buildId?: string;
  lastError?: string;
  requestId?: string;
  network?: string;
}
