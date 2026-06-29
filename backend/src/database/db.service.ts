import { Inject, Injectable } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { PG_POOL } from './database.tokens';

/**
 * Тонкая обёртка над pg.Pool. Бизнес-данные — durable source of truth (master).
 * Финансовые мутации (Этап 2) обязаны идти через withTransaction (ACID).
 */
@Injectable()
export class DbService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  query<T extends QueryResultRow = any>(
    text: string,
    params: any[] = [],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, params);
  }

  async one<T extends QueryResultRow = any>(
    text: string,
    params: any[] = [],
  ): Promise<T | null> {
    const res = await this.pool.query<T>(text, params);
    return res.rows[0] ?? null;
  }

  async many<T extends QueryResultRow = any>(
    text: string,
    params: any[] = [],
  ): Promise<T[]> {
    const res = await this.pool.query<T>(text, params);
    return res.rows;
  }

  /**
   * Транзакция с автоматическим commit/rollback и retry на конкурентных
   * конфликтах Postgres (40001 serialization_failure, 40P01 deadlock_detected).
   * Перемещение карточек под нагрузкой даёт встречные блокировки строк —
   * безопасный повтор делает операцию устойчивой (Этап 1, стабилизация).
   */
  async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const RETRYABLE = new Set(['40001', '40P01']);
    const MAX_ATTEMPTS = 5;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        lastErr = err;
        const code = (err as { code?: string })?.code;
        if (code && RETRYABLE.has(code) && attempt < MAX_ATTEMPTS) {
          // экспоненциальный бэкофф с джиттером
          const delay = 10 * 2 ** (attempt - 1) + Math.floor(Math.random() * 10);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      } finally {
        client.release();
      }
    }
    throw lastErr;
  }
}
