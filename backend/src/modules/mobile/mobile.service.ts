import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { AuthUser } from '../../common/auth/jwt.types';
import { SessionsService } from '../auth/sessions.service';
import { DeviceInput, MobileDevicesRepository } from './mobile-devices.repository';
import { InboxRepository } from '../notifications/inbox.repository';
import { TasksRepository } from '../tasks/tasks.repository';
import { ApprovalsRepository } from '../approvals/approvals.repository';
import { ChangeLogRepository, ChangeRef } from './change-log.repository';

export interface SyncPage {
  /** С чего продолжать в следующий раз. */
  cursor: string;
  /** Курсор клиента старше журнала: локальный кэш выбросить и загрузить всё заново. */
  reset: boolean;
  /** Есть ли ещё — клиент зовёт снова с новым курсором. */
  more: boolean;
  changes: ChangeRef[];
}

@Injectable()
export class MobileService {
  constructor(
    private readonly devices: MobileDevicesRepository,
    private readonly sessions: SessionsService,
    private readonly inbox: InboxRepository,
    private readonly tasks: TasksRepository,
    private readonly approvals: ApprovalsRepository,
    private readonly changes: ChangeLogRepository,
  ) {}

  /**
   * Delta-sync (ТЗ-9, волна 9): «что изменилось после моего курсора».
   *
   * Отдаём ссылки, не содержимое: задача №N обновлена до версии 9, сообщение M
   * удалено. Клиент перечитывает нужное обычными ручками — с их правами и форматом,
   * второй «мобильный» формат задачи нам не нужен. Первый заход без курсора — не
   * история, а просто «вот голова журнала», дальше клиент читает разделы как обычно.
   *
   * Журнал живёт 30 дней. Курсор старше — честно говорим `reset`: делать вид, что
   * ничего не пропущено, хуже, чем один раз перечитать.
   */
  async sync(user: AuthUser, cursor: string | null, limit: number): Promise<SyncPage> {
    if (!cursor) {
      return { cursor: await this.changes.head(user.tenantId), reset: false, more: false, changes: [] };
    }
    const oldest = await this.changes.oldest(user.tenantId);
    // журнал начинается позже курсора — между ними могло быть что угодно
    if (oldest && BigInt(oldest) > BigInt(cursor) + BigInt(1)) {
      return { cursor: await this.changes.head(user.tenantId), reset: true, more: false, changes: [] };
    }
    const rows = await this.changes.after(user.tenantId, user, cursor, limit + 1);
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    const next = page.length ? page[page.length - 1].id : (more ? cursor : await this.changes.head(user.tenantId));
    return { cursor: next, reset: false, more, changes: page };
  }

  /**
   * «Фокус дня» одним запросом (ТЗ-9, волна 5).
   *
   * Экран собирался четырьмя запросами: мои задачи, порученные, на проверке,
   * согласования. На телефоне четыре запроса — четыре шанса поймать таймаут в
   * лифте. Логика та же, что у отдельных ручек: те же репозитории, те же права —
   * здесь только параллельный вызов и один конверт.
   */
  async focus(tenantId: string, userId: string) {
    const [mine, delegated, review, approvals] = await Promise.all([
      this.tasks.listForUser(tenantId, userId, 'mine', true),
      this.tasks.listForUser(tenantId, userId, 'delegated', false),
      this.tasks.listForUser(tenantId, userId, 'review', false),
      this.approvals.inbox(tenantId, userId),
    ]);
    return { mine, delegated, review, approvals };
  }

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