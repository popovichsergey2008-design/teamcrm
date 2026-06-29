import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiSuccess } from './api-response';

/** Оборачивает успешный ответ контроллера в конверт {ok:true,data,meta}. */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiSuccess<T>> {
  intercept(context: ExecutionContext, next: CallHandler): Observable<ApiSuccess<T>> {
    // только для HTTP; WebSocket-эмиссии не оборачиваем
    if (context.getType() !== 'http') {
      return next.handle() as Observable<ApiSuccess<T>>;
    }
    return next.handle().pipe(
      map((data: any) => {
        if (data && typeof data === 'object' && 'ok' in data) {
          return data as ApiSuccess<T>;
        }
        const meta = data && typeof data === 'object' ? (data.__meta as Record<string, unknown>) : undefined;
        if (meta) delete (data as any).__meta;
        return { ok: true, data, ...(meta ? { meta } : {}) };
      }),
    );
  }
}
