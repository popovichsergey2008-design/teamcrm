import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AppException } from '../http/app-exception';
import { IS_PUBLIC_KEY } from './decorators';
import { AccessTokenPayload, AuthUser } from './jwt.types';
import { SessionRevocationService } from './session-revocation.service';

/** Глобальный guard: проверяет access-токен и прикрепляет req.user. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
    private readonly revoked: SessionRevocationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const token = this.extract(req);
    if (!token) throw AppException.unauthorized('Missing bearer token');

    let payload: AccessTokenPayload & { kind?: string };
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload & { kind?: string }>(token, {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      });
    } catch {
      throw AppException.unauthorized('Invalid or expired token');
    }
    // Гостевой токен созвона подписан ТЕМ ЖЕ ключом, но пользователем не является:
    // без этой проверки он открыл бы любой маршрут, где роли не указаны явно.
    if (payload.kind === 'guest' || !payload.sub || !payload.role) {
      throw AppException.unauthorized('Invalid or expired token');
    }
    /*
      Отозванная сессия — отказ сразу, а не через 15 минут (ТЗ-9). Код свой:
      клиент по нему не идёт обновлять токен, а выходит и чистит устройство.
    */
    if (payload.sid && await this.revoked.isRevoked(String(payload.sid))) {
      throw new AppException('SESSION_REVOKED', 'Сессия отозвана — войдите снова');
    }
    {
      const user: AuthUser = {
        userId: payload.sub,
        tenantId: payload.tenantId,
        role: payload.role,
        email: payload.email,
        sessionId: payload.sid,
      };
      (req as any).user = user;
      return true;
    }
  }

  private extract(req: Request): string | null {
    const header = req.headers['authorization'];
    if (!header) return null;
    const [type, value] = header.split(' ');
    return type === 'Bearer' && value ? value : null;
  }
}
