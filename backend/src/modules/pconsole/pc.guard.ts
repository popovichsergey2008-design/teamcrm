import { CanActivate, createParamDecorator, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppException } from '../../common/http/app-exception';
import { PcRepository } from './pc.repository';
import { PcAuthService } from './pc-auth.service';
import { canEnter, isPcApp, PcApp, PcPerm, permsFor } from './pc-rules';

export const PC_PERM_KEY = 'pcPerm';
/** Право консоли на маршрут. Без него маршрут закрыт: невыданное запрещено (§7). */
export const PcNeed = (perm: PcPerm | 'any') => SetMetadata(PC_PERM_KEY, perm);

export interface PcAuth {
  accountId: string;
  sessionId: string;
  email: string;
  name: string;
  app: PcApp;
  roles: string[];
  perms: PcPerm[];
}

const appOf = (perm: PcPerm): PcApp => (perm.startsWith('dev.') ? 'developer' : perm.startsWith('support.') ? 'support' : 'owner');

/**
 * Проверка консоли на КАЖДЫЙ запрос: подпись токена консоли, живая сессия, активный
 * человек, роль этой консоли — свежие из базы, не из токена. Отозвали роль или
 * заблокировали — следующий же запрос получает 401/403, а не ждёт конца токена.
 * Маршруты консоли помечены @Public для guard'а CRM: токен CRM здесь не действует.
 */
@Injectable()
export class PcGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly auth: PcAuthService, private readonly repo: PcRepository) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const need = this.reflector.getAllAndOverride<PcPerm | 'any' | undefined>(PC_PERM_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!need) throw AppException.forbidden('Маршрут консоли без права');
    const req = ctx.switchToHttp().getRequest();
    const header = String(req.headers?.authorization ?? '');
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const p = token ? this.auth.verifyAccess(token) : null;
    if (!p) throw AppException.unauthorized('Войдите в консоль');
    const s = await this.repo.sessionAuth(p.sid);
    if (!s || s.account_id !== p.sub || s.app !== p.app) throw AppException.unauthorized('Сессия закончилась — войдите заново');
    if (s.status !== 'active' || !isPcApp(s.app) || !canEnter(s.roles, s.app)) throw AppException.forbidden('Доступ закрыт');
    const perms = permsFor(s.roles, s.app);
    if (need !== 'any' && (appOf(need) !== s.app || !perms.includes(need))) throw AppException.forbidden('Недостаточно прав');
    const auth: PcAuth = { accountId: s.account_id, sessionId: s.session_id, email: s.email, name: s.full_name, app: s.app, roles: s.roles, perms };
    req.pc = auth;
    return true;
  }
}

export const CurrentPc = createParamDecorator((_: unknown, ctx: ExecutionContext): PcAuth => ctx.switchToHttp().getRequest().pc);
