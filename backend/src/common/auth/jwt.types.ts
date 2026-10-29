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
  /**
   * Политика организации требует второй фактор, а он не включён: токен пускает только
   * к настройке защиты (см. MFA_SETUP_PATHS). Включил — следующий токен уже без отметки.
   */
  mfa?: 'setup';
}

/** Куда пускает токен с отметкой mfa=setup: вход, сам второй фактор и профиль для экрана. */
export function allowedDuringMfaSetup(method: string, path: string): boolean {
  const p = path.split('?')[0];
  return p.startsWith('/api/auth/') || (method === 'GET' && p === '/api/me');
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
