import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Request } from 'express';
import { Observable, from, of } from 'rxjs';
import { switchMap, tap } from 'rxjs/operators';
import { RedisService } from '../../cache/redis.service';
import { AppException } from './app-exception';

const TTL_S = 24 * 3600;
const PENDING_S = 30;

/**
 * Idempotency-Key на записывающих запросах (ТЗ-9, волна 9).
 *
 * Телефон без сети ставит правку в очередь и отправляет, когда сеть вернётся. Сеть
 * может вернуться на полсекунды: запрос ушёл, ответ не дошёл — и клиент шлёт его снова.
 * Без ключа это второй комментарий, второе сообщение, вторая задача. С ключом второй
 * запрос получает ответ первого — сервер ничего не делает повторно.
 *
 * Ключ — uuid, который придумал клиент (он же id записи в его очереди). Живёт сутки:
 * дольше очередь не лежит. Пока первый запрос в работе, второй с тем же ключом
 * получает 409 — не ждать, а повторить через секунду.
 *
 * Запросы без заголовка проходят как раньше: веб ничего не знает об этом.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly redis: RedisService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<Request & { user?: { userId?: string; tenantId?: string } }>();
    const key = String(req.headers['idempotency-key'] ?? '').trim();
    if (!key || !['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return next.handle();
    if (!/^[A-Za-z0-9._-]{8,128}$/.test(key)) throw AppException.validation('Idempotency-Key: 8–128 знаков, буквы, цифры, ._-');

    // ключ личный: чужой ключ не должен ни отдать чужой ответ, ни заблокировать
    const who = `${req.user?.tenantId ?? '0'}:${req.user?.userId ?? '0'}`;
    const rkey = `idem:${who}:${req.method}:${req.path}:${key}`;

    return from(this.claim(rkey)).pipe(
      switchMap((state) => {
        if (state.kind === 'done') return of(state.body);
        if (state.kind === 'pending') throw AppException.conflict('Этот запрос уже выполняется — повторите через секунду');
        return next.handle().pipe(
          tap({
            next: (body) => { void this.redis.client.set(rkey, JSON.stringify({ body }), 'EX', TTL_S).catch(() => undefined); },
            // ошибка — не результат: следующая попытка должна выполниться заново
            error: () => { void this.redis.client.del(rkey).catch(() => undefined); },
          }),
        );
      }),
    );
  }

  private async claim(rkey: string): Promise<{ kind: 'new' } | { kind: 'pending' } | { kind: 'done'; body: unknown }> {
    try {
      const ok = await this.redis.client.set(rkey, 'pending', 'EX', PENDING_S, 'NX');
      if (ok === 'OK') return { kind: 'new' };
      const raw = await this.redis.client.get(rkey);
      if (raw === 'pending') return { kind: 'pending' };
      if (raw) return { kind: 'done', body: (JSON.parse(raw) as { body: unknown }).body };
      return { kind: 'new' };
    } catch {
      return { kind: 'new' }; // Redis лёг — работаем без защиты, а не отказываем
    }
  }
}