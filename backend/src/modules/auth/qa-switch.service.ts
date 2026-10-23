import { Injectable } from '@nestjs/common';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { SecurityRepository } from '../security/security.repository';
import { UsersRepository } from '../users/users.repository';
import { toPublicUser } from '../users/users.service';
import { AuthService, SessionMeta } from './auth.service';
import { RefreshTokenRepository } from './refresh-token.repository';
import { QaSwitchRepository } from './qa-switch.repository';
import { backRefusal, QA_REFUSAL_TEXT, switchRefusal } from './qa-switch.rules';

export interface QaSwitchStatus {
  canSwitch: boolean;
  targetId?: string;
  targetName?: string;
  actingAs?: { actorName: string };
}

/**
 * #1562: временная кнопка «Войти как qa test» для проверки интерфейса.
 *
 * Токены цели несут actorId — кто на самом деле. Вернуться можно только к нему и только
 * пока строка допуска на месте. Сессия, из которой переключились, закрывается в базе
 * (без мгновенного отзыва в Redis: запросы старым access-токеном, ещё летящие в момент
 * переключения, не должны получить SESSION_REVOKED и разлогинить уже новую сессию).
 */
@Injectable()
export class QaSwitchService {
  constructor(
    private readonly repo: QaSwitchRepository,
    private readonly auth: AuthService,
    private readonly users: UsersRepository,
    private readonly refreshTokens: RefreshTokenRepository,
    private readonly security: SecurityRepository,
  ) {}

  async status(u: Pick<AuthUser, 'tenantId' | 'userId' | 'actorId'>): Promise<QaSwitchStatus> {
    if (u.actorId) {
      const actor = await this.repo.person(u.tenantId, u.actorId);
      return { canSwitch: false, actingAs: { actorName: actor?.full_name ?? '' } };
    }
    const [target] = await this.repo.targetsOf(u.tenantId, u.userId);
    return target ? { canSwitch: true, targetId: target.id, targetName: target.full_name } : { canSwitch: false };
  }

  async switchTo(u: AuthUser, targetId: string | undefined, meta: SessionMeta) {
    if (u.actorId) throw AppException.forbidden(QA_REFUSAL_TEXT.chain);
    const id = targetId ?? (await this.repo.targetsOf(u.tenantId, u.userId))[0]?.id;
    if (!id) throw AppException.forbidden(QA_REFUSAL_TEXT.no_access);
    const refusal = switchRefusal({
      tenantId: u.tenantId, callerId: u.userId, actingFor: u.actorId, targetId: id,
      hasAccess: await this.repo.hasAccess(u.tenantId, u.userId, id),
      target: await this.repo.person(u.tenantId, id),
    });
    // чужим не подсказываем, существует ли цель: без строки ответ всегда один и тот же
    if (refusal) throw AppException.forbidden(QA_REFUSAL_TEXT[refusal]);

    const target = await this.users.findById(u.tenantId, id);
    if (!target) throw AppException.forbidden(QA_REFUSAL_TEXT.target_missing);
    await this.journal(u, 'qa.switch', u.userId, id, meta);
    const tokens = await this.auth.issueFor(target, meta, u.userId);
    await this.closeSource(u.sessionId);
    return { user: toPublicUser(target), ...tokens };
  }

  async back(u: AuthUser, meta: SessionMeta) {
    const actor = u.actorId ? await this.repo.person(u.tenantId, u.actorId) : null;
    const refusal = backRefusal({
      tenantId: u.tenantId, currentId: u.userId, actorId: u.actorId,
      hasAccess: !!u.actorId && await this.repo.hasAccess(u.tenantId, u.actorId, u.userId),
      actor,
    });
    if (refusal) throw AppException.forbidden(QA_REFUSAL_TEXT[refusal]);

    const me = await this.users.findById(u.tenantId, String(u.actorId));
    if (!me) throw AppException.forbidden(QA_REFUSAL_TEXT.actor_missing);
    await this.journal(u, 'qa.switch.back', String(u.actorId), u.userId, meta);
    const tokens = await this.auth.issueFor(me, meta);
    await this.closeSource(u.sessionId);
    return { user: toPublicUser(me), ...tokens };
  }

  private async closeSource(sessionId?: string) {
    if (sessionId) await this.refreshTokens.revoke(String(sessionId)).catch(() => undefined);
  }

  private async journal(u: AuthUser, event: string, actorId: string, targetId: string, meta: SessionMeta) {
    const actor = await this.repo.person(u.tenantId, actorId);
    await this.security.audit({
      tenantId: u.tenantId, actorId, actorName: actor?.full_name ?? null, event,
      resourceType: 'user', resourceId: targetId, targetUserId: targetId,
      ip: meta.ip ?? null, deviceId: await this.repo.deviceOf(u.sessionId).catch(() => null),
      metadata: { userAgent: meta.userAgent ?? null },
    });
  }
}
