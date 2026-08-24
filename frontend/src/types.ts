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
  status: string;
  is_blocked: boolean;
  agent_assigned?: boolean;
  cost_current?: string; // отсутствует в client-представлении (фича №9)
  risk_level?: 'green' | 'yellow' | 'red' | null; // светофор честных сроков (Этап 4)
  risk_pct?: string | null;
  predicted_finish_at?: string | null;
  estimate_hours?: string | null;
  deadline_at?: string | null;
  closed_at?: string | null;
  priority?: string;
  labels?: { id: string; name: string; color: string }[];
  commentsCount?: number;
  attachmentsCount?: number;
  checklistTotal?: number;
  checklistDone?: number;
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
