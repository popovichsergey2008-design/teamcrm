import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { ApiError, ErrorCode } from './api-response';

/** Приводит любое исключение к конверту {ok:false,error:{code,message,details}}. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code: ErrorCode = 'INTERNAL';
    let message = 'Internal server error';
    let details: Record<string, unknown> | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null && 'code' in body) {
        // AppException
        const b = body as any;
        code = b.code;
        message = b.message;
        details = b.details;
      } else {
        // штатные Nest-исключения (ValidationPipe и пр.)
        code = this.mapStatus(status);
        const b = body as any;
        message = (typeof b === 'string' ? b : b?.message) ?? exception.message;
        if (Array.isArray(message)) {
          // class-validator возвращает массив сообщений — показываем их пользователю
          details = { messages: message };
          message = message.join('; ') || 'Проверьте правильность заполнения полей';
          code = 'VALIDATION_FAILED';
        }
      }
    } else {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }

    const payload: ApiError = {
      ok: false,
      error: { code, message, ...(details ? { details } : {}) },
    };
    res.status(status).json(payload);
  }

  private mapStatus(status: number): ErrorCode {
    switch (status) {
      case 400:
        return 'VALIDATION_FAILED';
      case 401:
        return 'UNAUTHORIZED';
      case 403:
        return 'FORBIDDEN';
      case 404:
        return 'NOT_FOUND';
      case 409:
        return 'CONFLICT';
      case 429:
        return 'RATE_LIMITED';
      default:
        return 'INTERNAL';
    }
  }
}
