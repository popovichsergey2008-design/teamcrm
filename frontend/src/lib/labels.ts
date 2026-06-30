import type { RoleCode } from '../types';

/** Русские подписи уровней доступа (RBAC-роли). */
const ROLE_LABELS: Record<string, string> = {
  owner: 'Владелец',
  manager: 'Руководитель',
  member: 'Сотрудник',
  client: 'Клиент',
};

export function roleLabel(code?: string | null): string {
  if (!code) return '';
  return ROLE_LABELS[code] ?? code;
}

/** Роли, назначаемые в команде (client выдаётся отдельно, через портал). */
export const ASSIGNABLE_ROLES: { value: RoleCode; label: string }[] = [
  { value: 'owner', label: ROLE_LABELS.owner },
  { value: 'manager', label: ROLE_LABELS.manager },
  { value: 'member', label: ROLE_LABELS.member },
];
