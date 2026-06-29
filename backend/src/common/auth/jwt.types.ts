export type RoleCode = 'owner' | 'manager' | 'member' | 'client';

/** Полезная нагрузка access-токена. tenant_id и role берутся ТОЛЬКО отсюда. */
export interface AccessTokenPayload {
  sub: string; // user id (string, т.к. BIGINT)
  tenantId: string;
  role: RoleCode;
  email: string;
}

/** Прикреплённый к запросу/сокету аутентифицированный пользователь. */
export interface AuthUser {
  userId: string;
  tenantId: string;
  role: RoleCode;
  email: string;
}
