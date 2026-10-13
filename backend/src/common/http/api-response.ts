/** Единый API-конверт (master → API envelope). */
export interface ApiSuccess<T> {
  ok: true;
  data: T;
  meta?: Record<string, unknown>;
}

export interface ApiError {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
    /** Номер запроса — по нему специалист находит строку в журнале (волна 10). */
    requestId?: string;
  };
}

export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHORIZED'
  /** Сессию отозвали (администратор или сам человек с другого устройства): не обновлять, а выйти. */
  | 'SESSION_REVOKED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  /** Запрос понятен, но выполнить нельзя по смыслу: задача без проекта (ТЗ-31) и т. п. */
  | 'UNPROCESSABLE'
  | 'RATE_LIMITED'
  | 'INTERNAL';

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHORIZED: 401,
  SESSION_REVOKED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};
