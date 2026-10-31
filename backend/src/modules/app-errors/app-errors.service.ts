import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { ErrorReport, errorSink, fingerprint, routeOf, scrub, stackOf } from '../../common/errors/error-report';

const KEEP_DAYS = 30;
/** Потолок записей в минуту на процесс: шторм одинаковых ошибок не должен класть базу. */
const PER_MINUTE = 300;

export interface ErrorRow {
  id: string; fingerprint: string; source: string; kind: string; message: string; route: string | null;
  first_seen: Date; last_seen: Date; first_version: string | null; last_version: string | null; hits: string;
  status: string; fixed_at: Date | null; fixed_version: string | null; note: string | null;
  hits_24h: number; clients_7d: number;
}

/**
 * Ошибки приложения: принимаем, очищаем, группируем. Запись — в фоне и с потолком:
 * сбор ошибок не имеет права сам стать причиной ошибок или тормозов.
 */
@Injectable()
export class AppErrorsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('AppErrors');
  private window = { at: 0, n: 0 };
  private lastCleanup = 0;

  constructor(private readonly db: DbService) {}

  onModuleInit() { errorSink.report = (r) => { void this.capture(r); }; }
  onModuleDestroy() { errorSink.report = null; }

  async capture(raw: ErrorReport): Promise<void> {
    const now = Date.now();
    if (now - this.window.at > 60_000) this.window = { at: now, n: 0 };
    if (++this.window.n > PER_MINUTE) return;
    try {
      const r = {
        source: raw.source,
        kind: scrub(raw.kind || 'Error', 120),
        message: scrub(raw.message || '(без текста)', 500),
        stack: stackOf(raw.stack),
        route: raw.route ? routeOf(raw.route) : null,
        version: raw.version ? String(raw.version).slice(0, 64) : null,
      };
      const fp = fingerprint(r);
      // Вернулась «исправленная» — снова новая: так видно, что исправление не помогло (§4.3).
      const g = await this.db.one<{ id: string }>(
        `INSERT INTO app_errors (fingerprint, source, kind, message, route, stack, first_version, last_version, hits)
         VALUES ($1, $2, $3, $4, $5, $6, $7::varchar, $7::varchar, 1)
         ON CONFLICT (fingerprint) DO UPDATE SET
           hits = app_errors.hits + 1, last_seen = now(), last_version = coalesce(EXCLUDED.last_version, app_errors.last_version),
           message = EXCLUDED.message, stack = coalesce(EXCLUDED.stack, app_errors.stack), updated_at = now(),
           status = CASE WHEN app_errors.status = 'fixed' AND app_errors.fixed_at < now() - interval '5 minutes' THEN 'new' ELSE app_errors.status END
         RETURNING id::text`,
        [fp, r.source, r.kind, r.message, r.route, r.stack, r.version]);
      await this.db.query(
        `INSERT INTO app_error_events (error_id, request_id, version, route, tenant_id, user_id, client_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [g!.id, raw.requestId?.slice(0, 64) ?? null, r.version, r.route, raw.tenantId ?? null, raw.userId ?? null, raw.clientId?.slice(0, 64) ?? null]);
      if (now - this.lastCleanup > 3_600_000) {
        this.lastCleanup = now;
        await this.db.query(`DELETE FROM app_error_events WHERE at < now() - ($1::int * interval '1 day')`, [KEEP_DAYS]);
      }
    } catch (e) {
      // только в журнал: ошибка сбора ошибок не должна порождать новую запись сюда же
      this.log.warn(`ошибка не записалась: ${(e as Error).message}`);
    }
  }

  list(f: { status?: string; source?: string; q?: string }) {
    const q = f.q?.trim() || null;
    return this.db.many<ErrorRow>(
      `SELECT e.id::text, e.fingerprint, e.source, e.kind, e.message, e.route, e.first_seen, e.last_seen,
              e.first_version, e.last_version, e.hits::text, e.status, e.fixed_at, e.fixed_version, e.note,
              (SELECT count(*) FROM app_error_events v WHERE v.error_id=e.id AND v.at > now() - interval '1 day')::int AS hits_24h,
              (SELECT count(DISTINCT coalesce(v.user_id::text, v.client_id)) FROM app_error_events v
                WHERE v.error_id=e.id AND v.at > now() - interval '7 days')::int AS clients_7d
         FROM app_errors e
        WHERE ($1::text IS NULL OR e.status = $1::text)
          AND ($2::text IS NULL OR e.source = $2::text)
          AND ($3::text IS NULL OR e.message ILIKE '%' || $3::text || '%' OR e.kind ILIKE '%' || $3::text || '%'
               OR EXISTS (SELECT 1 FROM app_error_events v WHERE v.error_id=e.id AND v.request_id = $3::text))
        ORDER BY (e.status = 'new') DESC, e.last_seen DESC
        LIMIT 200`,
      [f.status || null, f.source || null, q]);
  }

  async one(id: string) {
    const e = await this.db.one<ErrorRow & { stack: string | null }>(
      `SELECT id::text, fingerprint, source, kind, message, route, stack, first_seen, last_seen, first_version, last_version,
              hits::text, status, fixed_at, fixed_version, note, 0 AS hits_24h, 0 AS clients_7d
         FROM app_errors WHERE id=$1`, [id]);
    if (!e) return null;
    const events = await this.db.many<{ at: Date; request_id: string | null; version: string | null; route: string | null; tenant_id: string | null }>(
      `SELECT at, request_id, version, route, tenant_id::text FROM app_error_events WHERE error_id=$1 ORDER BY at DESC LIMIT 50`, [id]);
    const byVersion = await this.db.many<{ version: string | null; n: number }>(
      `SELECT version, count(*)::int AS n FROM app_error_events WHERE error_id=$1 GROUP BY version ORDER BY max(at) DESC LIMIT 10`, [id]);
    return { ...e, events, byVersion };
  }

  async setStatus(id: string, status: 'new' | 'fixed' | 'ignored', note: string | null, version: string | null) {
    const r = await this.db.query(
      `UPDATE app_errors SET status=$2::varchar, note=coalesce($3, note), updated_at=now(),
              fixed_at = CASE WHEN $2::varchar='fixed' THEN now() ELSE NULL END,
              fixed_version = CASE WHEN $2::varchar='fixed' THEN $4 ELSE NULL END
        WHERE id=$1`, [id, status, note, version]);
    return (r.rowCount ?? 0) > 0;
  }
}
