import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { SessionRevocationService } from '../../common/auth/session-revocation.service';
import { RefreshTokenRepository, SessionRow } from './refresh-token.repository';

/** Сессия для списка «устройства»: свои — человеку, сотрудников — руководству. */
export interface SessionView {
  id: string;
  userAgent: string | null;
  ip: string | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  current: boolean;
  /** Мобильное устройство, если вход был из оболочки (ТЗ-9). */
  device: {
    id: string; platform: string; model: string | null;
    nativeVersion: string | null; bundleVersion: string | null;
  } | null;
}

/**
 * Сессии и их отзыв (ТЗ-9, волна 3).
 *
 * Отзыв — это две вещи сразу: refresh-токен помечается в базе (обновиться нельзя)
 * и id сессии — в Redis (текущий access-токен перестаёт работать немедленно).
 * Делать второе забывали бы в каждом месте по отдельности, поэтому все отзывы
 * идут через этот сервис.
 */
@Injectable()
export class SessionsService {
  constructor(
    private readonly refresh: RefreshTokenRepository,
    private readonly revoked: SessionRevocationService,
  ) {}

  private view(r: SessionRow, currentSid?: string): SessionView {
    return {
      id: String(r.id),
      userAgent: r.user_agent,
      ip: r.ip,
      lastUsedAt: r.last_used_at,
      createdAt: r.created_at,
      current: currentSid !== undefined && String(r.id) === String(currentSid),
      device: r.device_id ? {
        id: String(r.device_id), platform: r.device_platform ?? 'web', model: r.device_model,
        nativeVersion: r.device_native_version, bundleVersion: r.device_bundle_version,
      } : null,
    };
  }

  async mine(userId: string, currentSid?: string): Promise<SessionView[]> {
    return (await this.refresh.listActive(userId)).map((r) => this.view(r, currentSid));
  }

  async revokeMine(userId: string, id: string): Promise<void> {
    await this.refresh.revokeOwned(userId, id);
    await this.revoked.markRevoked([String(id)]);
  }

  async revokeOthers(userId: string, currentSid?: string): Promise<void> {
    const ids = (await this.refresh.listActive(userId))
      .map((r) => String(r.id))
      .filter((id) => id !== String(currentSid ?? ''));
    await this.refresh.revokeAllExcept(userId, currentSid);
    await this.revoked.markRevoked(ids);
  }

  /** Отозвать конкретный список сессий (например, все сессии устройства). */
  async revokeIds(userId: string, ids: string[]): Promise<void> {
    for (const id of ids) await this.refresh.revokeOwned(userId, id);
    await this.revoked.markRevoked(ids);
  }

  // ── руководство: устройства сотрудника ──
  /**
   * Сотрудник обязан быть из той же организации: список сессий чужого человека —
   * это утечка, а не «пустой ответ». Проверка в самом запросе.
   */
  async ofEmployee(tenantId: string, userId: string): Promise<SessionView[]> {
    if (!(await this.refresh.userInTenant(tenantId, userId))) throw AppException.notFound('Сотрудник не найден');
    return (await this.refresh.listActive(userId)).map((r) => this.view(r));
  }

  async revokeEmployee(tenantId: string, userId: string, sessionId: string | null): Promise<void> {
    if (!(await this.refresh.userInTenant(tenantId, userId))) throw AppException.notFound('Сотрудник не найден');
    const ids = (await this.refresh.listActive(userId)).map((r) => String(r.id))
      .filter((id) => sessionId === null || id === String(sessionId));
    if (sessionId === null) await this.refresh.revokeAllExcept(userId);
    else await this.refresh.revokeOwned(userId, sessionId);
    await this.revoked.markRevoked(ids);
  }
}