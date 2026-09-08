import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppException } from '../http/app-exception';
import { IS_PUBLIC_KEY, ROLES_KEY } from './decorators';
import { AuthUser, RoleCode } from './jwt.types';

/** Глобальный RBAC-guard: сверяет роль из токена с @Roles(...) маршрута. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    /*
      Открытый маршрут ролей не имеет — и не может иметь.

      @Public() ставится ПОВЕРХ контроллера, у которого роли объявлены на классе:
      лента календаря по секретной ссылке, вход, приглашения. Пользователя у такого
      запроса нет по определению — его читает Google или почтовый клиент, — и проверка
      ролей отвечала им 401, хотя маршрут объявлен открытым.

      Ровно на это мы и наступили с лентой календаря: `@Public()` стоял, а ответ был
      «Unauthorized», и понять почему по ответу было нельзя.
    */
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<RoleCode[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest();
    const user: AuthUser | undefined = req.user;
    if (!user) throw AppException.unauthorized();
    if (!required.includes(user.role)) {
      throw AppException.forbidden('Insufficient role');
    }
    return true;
  }
}
