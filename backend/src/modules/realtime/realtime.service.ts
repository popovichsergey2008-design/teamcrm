import { Injectable } from '@nestjs/common';
import { Server } from 'socket.io';

/** Доменные события (master → Realtime контракт). */
export type DomainEvent =
  | 'task.created'
  | 'task.updated'
  | 'task.moved'
  | 'task.deleted'
  | 'column.updated'
  // Проект переименовали или закрыли от посторонних: списки и шапка доски перечитываются
  | 'project.updated'
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

  /*
    «Что-то изменилось» — одним сигналом (#1531).

    События задач уходят в комнату проекта, а в неё входит только открытая доска.
    Счётчики в меню, «Фокус дня», реестр задач, таблица проектов и шторка их не
    получали и обновлялись раз в минуту или при переходе в другой раздел. Теперь
    каждое событие задач, согласований и ящика заодно ставит в очередь короткий
    сигнал `data.changed` — всей компании (для проектных событий) или адресатам
    (для личных). Сигналы склеиваются за SIGNAL_MS: пачка правок — один перезапрос.
    В сигнале нет содержимого — только что за событие и в каком проекте.
  */
  private readonly pending = new Map<string, { projects: Set<string>; events: Set<string>; timer: NodeJS.Timeout }>();
  private static readonly SIGNAL_MS = 300;
  private static readonly SIGNAL_PREFIXES = ['task.', 'approval.', 'inbox.', 'column.', 'board.', 'project.', 'focus.day', 'deal.', 'client.'];

  private static signals(event: string): boolean {
    return RealtimeService.SIGNAL_PREFIXES.some((p) => event.startsWith(p));
  }

  private queueSignal(room: string, event: string, projectId: string | null) {
    if (!this.server) return;
    let entry = this.pending.get(room);
    if (!entry) {
      entry = {
        projects: new Set(), events: new Set(),
        timer: setTimeout(() => {
          const e = this.pending.get(room);
          this.pending.delete(room);
          if (!e || !this.server) return;
          this.server.to(room).emit('data.changed', { projects: [...e.projects], events: [...e.events] });
        }, RealtimeService.SIGNAL_MS),
      };
      this.pending.set(room, entry);
    }
    entry.events.add(event);
    if (projectId) entry.projects.add(String(projectId));
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
  /** Сотрудники компании без клиентского портала: сюда идёт сигнал `data.changed` (#1531). */
  static staffRoom(tenantId: string) {
    return `staff:${tenantId}`;
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

  /**
   * Событие всем сотрудникам компании, без клиентского портала (ТЗ-20: лента).
   * В событии — только номер поста и что случилось: видит ли человек пост, решает
   * сервер, когда экран его перезапросит.
   */
  emitToStaff(tenantId: string, event: string, payload: Record<string, unknown>) {
    if (!this.server) return;
    this.server.to(RealtimeService.staffRoom(tenantId)).emit(event, payload);
  }

  /** Сообщение чата адресатам: у каждого свои устройства, комната решает это сама. */
  emitToUsers(tenantId: string, userIds: string[], event: string, payload: Record<string, unknown>) {
    if (!this.server) return;
    const signal = RealtimeService.signals(event);
    for (const userId of new Set(userIds)) {
      this.server.to(RealtimeService.userRoom(tenantId, userId)).emit(event, payload);
      if (signal) this.queueSignal(RealtimeService.userRoom(tenantId, userId), event, null);
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
    if (RealtimeService.signals(event)) this.queueSignal(RealtimeService.staffRoom(tenantId), event, projectId);
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
    if (RealtimeService.signals(event)) this.queueSignal(RealtimeService.staffRoom(tenantId), event, projectId);
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
