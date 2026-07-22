export type RoleCode = 'owner' | 'manager' | 'member' | 'client';

export interface User {
  id: string;
  tenantId: string;
  email: string;
  fullName: string;
  role: RoleCode;
  isActive: boolean;
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
