import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, from, switchMap } from 'rxjs';
import { AppException } from '../../common/http/app-exception';
import { AuthUser } from '../../common/auth/jwt.types';
import { allowedWhenReadOnly } from './billing-rules';
import { BillingService } from './billing.service';

/**
 * «Только чтение» для неоплаченной компании (мастер-план §36): смотреть можно всё,
 * менять — нет. Данные не удаляются. Перехватчик, а не охранник: охранники разных модулей
 * идут в неизвестном порядке, а перехватчики — после всех охранников, когда человек уже узнан.
 */
@Injectable()
export class ReadOnlyInterceptor implements NestInterceptor {
  constructor(private readonly billing: BillingService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest();
    const user = req.user as AuthUser | undefined;
    if (!user?.tenantId || allowedWhenReadOnly(req.method, req.originalUrl ?? req.url)) return next.handle();
    return from(this.billing.state(user.tenantId).catch(() => null)).pipe(
      switchMap((s) => {
        if (s && !s.writable) {
          throw new AppException('FORBIDDEN', 'QEVO в режиме «только чтение»: подписка не оплачена. Владелец может оплатить в «Настройки → Тариф и оплата» — всё заработает сразу', { billing: 'read_only' });
        }
        return next.handle();
      }),
    );
  }
}
