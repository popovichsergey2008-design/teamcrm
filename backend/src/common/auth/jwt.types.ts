export type RoleCode = 'owner' | 'manager' | 'member' | 'client';

/** Полезная нагрузка access-токена. tenant_id и role берутся ТОЛЬКО отсюда. */
export interface AccessTokenPayload {
  sub: string; // user id (string, т.к. BIGINT)
  tenantId: string;
  role: RoleCode;
  email: string;
  sid?: string; // id refresh-сессии (refresh_tokens.id) — для управления сессиями
  /** #1562: кто на самом деле вошёл под тестовым сотрудником (users.id). */
  act?: string;
}

/** Прикреплённый к запросу/сокету аутентифицированный пользователь. */
export interface AuthUser {
  userId: string;
  tenantId: string;
  role: RoleCode;
  email: string;
  sessionId?: string;
  /** #1562: сессия тестового сотрудника, открытая этим человеком (см. qa-switch). */
  actorId?: string;
}
