import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppException } from '../http/app-exception';
import { ROLES_KEY } from './decorators';
import { AuthUser, RoleCode } from './jwt.types';

/** Глобальный RBAC-guard: сверяет роль из токена с @Roles(...) маршрута. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
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
