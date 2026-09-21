import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { AuthUser } from '../../common/auth/jwt.types';
import { SessionsService } from '../auth/sessions.service';
import { DeviceInput, MobileDevicesRepository } from './mobile-devices.repository';
import { InboxRepository } from '../notifications/inbox.repository';

@Injectable()
export class MobileService {
  constructor(
    private readonly devices: MobileDevicesRepository,
    private readonly sessions: SessionsService,
    private readonly inbox: InboxRepository,
  ) {}

  /**
   * Ящик уведомлений по курсору (ТЗ-9): push — сигнал, ящик — правда.
   * Без курсора — последние записи; `cursor` в ответе клиент хранит и присылает дальше.
   */
  async notifications(userId: string, after: string | null, limit: number) {
    const rows = after ? await this.inbox.after(userId, after, limit) : (await this.inbox.latest(userId, limit)).reverse();
    const unread = await this.inbox.unreadCount(userId);
    return {
      items: rows.map((r) => ({
        id: String(r.id), eventKey: r.event_key, title: r.title, body: r.body, path: r.path,
        createdAt: r.created_at, readAt: r.read_at,
      })),
      cursor: rows.length ? String(rows[rows.length - 1].id) : after,
      unread,
    };
  }

  markRead(userId: string, upTo: string) {
    return this.inbox.markRead(userId, upTo);
  }

  /**
   * Устройство + текущая сессия.
   *
   * Сессия узнаётся по sid из access-токена: клиенту не нужно ничего знать о
   * своих сессиях, он просто говорит «я такой-то телефон» — и вход, которым он
   * это сказал, становится входом с этого телефона.
   */
  async register(u: AuthUser, d: DeviceInput) {
    const row = await this.devices.upsert(u.tenantId, u.userId, d);
    if (!row) throw AppException.conflict('Не удалось зарегистрировать устройство');
    if (u.sessionId) await this.devices.bindSession(String(row.id), String(u.sessionId));
    return { id: String(row.id), platform: row.platform, model: row.model };
  }

  async mine(userId: string) {
    return (await this.devices.listMine(userId)).map((r) => ({
      id: String(r.id), platform: r.platform, model: r.model, osVersion: r.os_version,
      nativeVersion: r.native_version, bundleVersion: r.web_bundle_version,
      lastSeenAt: r.last_seen_at, createdAt: r.created_at,
    }));
  }

  async revoke(userId: string, id: string): Promise<void> {
    const row = await this.devices.byIdOwned(userId, id);
    if (!row) throw AppException.notFound('Устройство не найдено');
    const ids = (await this.devices.sessionIdsOf(String(row.id))).map((s) => String(s.id));
    await this.sessions.revokeIds(userId, ids);
    await this.devices.revoke(String(row.id));
  }
}