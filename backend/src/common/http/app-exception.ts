import { HttpException } from '@nestjs/common';
import { ERROR_HTTP_STATUS, ErrorCode } from './api-response';

/**
 * Доменное исключение с кодом из API-конверта. Сервисы бросают AppException,
 * фильтр приводит его к {ok:false,error:{...}}.
 */
export class AppException extends HttpException {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super({ code, message, details }, ERROR_HTTP_STATUS[code]);
  }

  static validation(message = 'Validation failed', details?: Record<string, unknown>) {
    return new AppException('VALIDATION_FAILED', message, details);
  }
  static unauthorized(message = 'Unauthorized') {
    return new AppException('UNAUTHORIZED', message);
  }
  static forbidden(message = 'Forbidden') {
    return new AppException('FORBIDDEN', message);
  }
  static notFound(message = 'Not found') {
    return new AppException('NOT_FOUND', message);
  }
  static conflict(message = 'Conflict', details?: Record<string, unknown>) {
    return new AppException('CONFLICT', message, details);
  }
}
