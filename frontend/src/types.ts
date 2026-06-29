export type RoleCode = 'owner' | 'manager' | 'member' | 'client';

export interface User {
  id: string;
  tenantId: string;
  email: string;
  fullName: string;
  role: RoleCode;
  isActive: boolean;
}

export interface AuthResult {
  user: User;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface Project {
  id: string;
  name: string;
  status: string;
  budget?: string | null;
  client_id?: string | null;
  deal_id?: string | null;
}

export interface Task {
  id: string;
  project_id: string;
  column_id: string;
  position: number;
  title: string;
  description: string | null;
  assignee_id: string | null;
  status: string;
  is_blocked: boolean;
  cost_current?: string; // отсутствует в client-представлении (фича №9)
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
