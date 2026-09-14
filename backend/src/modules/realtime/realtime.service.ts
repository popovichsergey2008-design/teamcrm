import { Injectable } from '@nestjs/common';
import { Server } from 'socket.io';

/** Доменные события (master → Realtime контракт). */
export type DomainEvent =
  | 'task.created'
  | 'task.updated'
  | 'task.moved'
  | 'task.deleted'
  | 'column.updated'
  | 'deal.converted'
  // Этап 2: нефинансовые события трекинга (можно в обе комнаты)
  | 'time.started'
  | 'time.stopped'
  // Этап 3: нефинансовые события дейлика
  | 'task.blocked'
  | 'standup.applied';

/**
 * События ТОЛЬКО для internal-комнаты, никогда клиентам (фича №9):
 * финансовые (Этап 2) + внутренние метрики/риск/рекомендации (Этап 4).
 */
export type FinancialEvent =
  | 'task.cost_changed'
  | 'project.pnl_changed'
  | 'alert.raised'
  | 'alert.resolved'
  | 'task.risk_changed'
  | 'overload.warned';

/**
 * Поля, которые НИКОГДА не уходят в клиентскую комнату (фича №9 «маржа-сейф»).
 * На Этапе 1 финансов ещё нет, но контракт фиксируется здесь.
 */
const FINANCIAL_KEYS = new Set([
  'cost_current',
  'costCurrent',
  'cost',
  'budget',
  'amount',
  'planned_margin',
  'plannedMargin',
  'margin',
  'hourly_rate',
  'hourlyRate',
  'rate',
]);

function stripFinancial<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripFinancial) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FINANCIAL_KEYS.has(k)) continue;
      out[k] = stripFinancial(v);
    }
    return out as T;
  }
  return value;
}

@Injectable()
export class RealtimeService {
  private server: Server | null = null;

  setServer(server: Server) {
    this.server = server;
  }

  /** Кто сейчас онлайн: сокеты по пользователю (мессенджер показывает точку «в сети»). */
  private readonly online = new Map<string, number>();

  static internalRoom(tenantId: string, projectId: string) {
    return `project:${tenantId}:${projectId}`;
  }
  static clientRoom(tenantId: string, projectId: string) {
    return `project:${tenantId}:${projectId}:client`;
  }
  /** Личная комната — доставка сообщений мессенджера конкретному человеку. */
  static userRoom(tenantId: string, userId: string) {
    return `user:${tenantId}:${userId}`;
  }
  /** Комната компании — то, что должны узнать все сразу: статус коллеги, новый чат. */
  static tenantRoom(tenantId: string) {
    return `tenant:${tenantId}`;
  }

  /** Событие всем сотрудникам компании: статусы присутствия и подобное. */
  emitToTenant(tenantId: string, event: string, payload: Record<string, unknown>) {
    if (!this.server) return;
    this.server.to(RealtimeService.tenantRoom(tenantId)).emit(event, payload);
  }

  /** Сообщение чата адресатам: у каждого свои устройства, комната решает это сама. */
  emitToUsers(tenantId: string, userIds: string[], event: string, payload: Record<string, unknown>) {
    if (!this.server) return;
    for (const userId of new Set(userIds)) {
      this.server.to(RealtimeService.userRoom(tenantId, userId)).emit(event, payload);
    }
  }

  private key(tenantId: string, userId: string) { return `${tenantId}:${userId}`; }

  presenceConnect(tenantId: string, userId: string) {
    const k = this.key(tenantId, userId);
    this.online.set(k, (this.online.get(k) ?? 0) + 1);
  }
  presenceDisconnect(tenantId: string, userId: string) {
    const k = this.key(tenantId, userId);
    const n = (this.online.get(k) ?? 1) - 1;
    if (n <= 0) this.online.delete(k); else this.online.set(k, n);
  }
  isOnline(tenantId: string, userId: string): boolean {
    return this.online.has(this.key(tenantId, userId));
  }
  onlineUsers(tenantId: string): string[] {
    const prefix = `${tenantId}:`;
    return [...this.online.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  }

  /**
   * Эмиссия доменного события участникам проекта.
   * Внутренняя комната получает полный payload; клиентская — без финансовых полей.
   */
  emit(
    tenantId: string,
    projectId: string,
    event: DomainEvent,
    payload: Record<string, unknown>,
  ) {
    if (!this.server) return;
    this.server
      .to(RealtimeService.internalRoom(tenantId, projectId))
      .emit(event, payload);
    this.server
      .to(RealtimeService.clientRoom(tenantId, projectId))
      .emit(event, stripFinancial(payload));
  }

  /**
   * Событие карточки (Этап D): во внутреннюю комнату всегда; в клиентскую — только если
   * контент клиент-видимый (напр. публичный комментарий). Финансовые поля стрипаются.
   */
  emitScoped(
    tenantId: string,
    projectId: string,
    event: string,
    payload: Record<string, unknown>,
    clientVisible = false,
  ) {
    if (!this.server) return;
    this.server.to(RealtimeService.internalRoom(tenantId, projectId)).emit(event, payload);
    if (clientVisible) {
      this.server.to(RealtimeService.clientRoom(tenantId, projectId)).emit(event, stripFinancial(payload));
    }
  }

  /**
   * Эмиссия ФИНАНСОВОГО события — только во внутреннюю комнату проекта.
   * Клиентская комната не получает событие вообще (фича №9).
   */
  emitInternal(
    tenantId: string,
    projectId: string,
    event: FinancialEvent,
    payload: Record<string, unknown>,
  ) {
    if (!this.server) return;
    this.server
      .to(RealtimeService.internalRoom(tenantId, projectId))
      .emit(event, payload);
  }
}
