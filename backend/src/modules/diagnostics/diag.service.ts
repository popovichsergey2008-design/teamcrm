import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export type DiagScope = 'meet' | 'chat';
export type DiagSide = 'server' | 'client';

export interface DiagEntry {
  tenantId?: string | null;
  scope: DiagScope;
  refId?: string | null;
  userId?: string | null;
  side: DiagSide;
  event: string;
  data?: unknown;
  /** Время события на стороне клиента: пачка приходит с задержкой, порядок важнее момента записи. */
  at?: string | null;
}

const KEEP_DAYS = 7;
const MAX_BATCH = 200;

/**
 * Журнал диагностики созвонов и чатов.
 *
 * Пишет и никогда не мешает: любая ошибка записи проглатывается. Диагностика,
 * из-за которой падает созвон, хуже отсутствия диагностики.
 */
@Injectable()
export class DiagService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Diag');
  private timer?: NodeJS.Timeout;

  constructor(private readonly db: DbService) {}

  onModuleInit() {
    // Журнал растёт быстро и стареет мгновенно: разбирают вчерашний созвон, не прошлогодний.
    const sweep = () => void this.purge().catch(() => undefined);
    this.timer = setInterval(sweep, 6 * 60 * 60 * 1000);
    this.timer.unref?.();
    setTimeout(sweep, 30_000).unref?.();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Одно событие. Вызывается из обработчиков сигналинга — без await. */
  write(e: DiagEntry): void {
    void this.writeMany([e]);
  }

  async writeMany(entries: DiagEntry[]): Promise<void> {
    const rows = entries.slice(0, MAX_BATCH);
    if (!rows.length) return;
    try {
      // Одним запросом: на активном созвоне событий десятки в секунду.
      const values: unknown[] = [];
      const chunks = rows.map((e, i) => {
        const b = i * 8;
        values.push(
          e.tenantId ?? null, e.scope, e.refId ?? null, e.userId ?? null,
          e.side, e.event.slice(0, 48), e.data === undefined ? null : JSON.stringify(e.data),
          e.at ?? null,
        );
        return `($${b + 1}::bigint,$${b + 2}::varchar,$${b + 3}::varchar,$${b + 4}::bigint,`
          + `$${b + 5}::varchar,$${b + 6}::varchar,$${b + 7}::jsonb,COALESCE($${b + 8}::timestamptz, now()))`;
      });
      await this.db.query(
        `INSERT INTO diag_events (tenant_id, scope, ref_id, user_id, side, event, data, created_at)
         VALUES ${chunks.join(',')}`,
        values,
      );
    } catch (e) {
      this.log.debug?.(`запись журнала не удалась: ${(e as Error).message}`);
    }
  }

  /** Лента одного созвона или чата по порядку. */
  timeline(scope: DiagScope, refId: string, limit = 500) {
    return this.db.many(
      `SELECT id, created_at, side, user_id, event, data
         FROM diag_events WHERE scope=$1 AND ref_id=$2 ORDER BY id LIMIT $3`,
      [scope, refId, Math.min(2000, limit)],
    );
  }

  /** Последние созвоны — чтобы найти нужный, не зная его номера. */
  recentRooms(scope: DiagScope, limit = 20) {
    return this.db.many(
      `SELECT ref_id, min(created_at) AS started, max(created_at) AS finished,
              count(*) AS events, count(DISTINCT user_id) AS people
         FROM diag_events WHERE scope=$1 AND ref_id IS NOT NULL
        GROUP BY ref_id ORDER BY max(created_at) DESC LIMIT $2`,
      [scope, Math.min(100, limit)],
    );
  }

  private async purge(): Promise<void> {
    await this.db.query(
      `DELETE FROM diag_events WHERE created_at < now() - ($1 || ' days')::interval`,
      [String(KEEP_DAYS)],
    );
  }
}
