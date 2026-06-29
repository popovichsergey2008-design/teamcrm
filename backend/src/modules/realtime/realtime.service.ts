import { Injectable } from '@nestjs/common';
import { Server } from 'socket.io';

/** Доменные события Этапа 1 (master → Realtime контракт). */
export type DomainEvent =
  | 'task.created'
  | 'task.updated'
  | 'task.moved'
  | 'column.updated'
  | 'deal.converted';

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

  static internalRoom(tenantId: string, projectId: string) {
    return `project:${tenantId}:${projectId}`;
  }
  static clientRoom(tenantId: string, projectId: string) {
    return `project:${tenantId}:${projectId}:client`;
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
}
