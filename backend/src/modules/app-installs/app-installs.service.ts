import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { DbService } from '../../database/db.service';
import { launchKind, osOf, parseDownload } from './install-rules';

export interface LaunchReport {
  installationId: string; platform: string; version?: string | null; os?: string | null;
  channel?: string | null; source?: string | null; tenantId?: string | null;
}

/** Тестовые компании и площадка вендора не идут в коммерческую статистику (как остальные показатели владельца). */
const NOT_TEST = `(i.tenant_id IS NULL OR i.tenant_id IN (SELECT id FROM tenants WHERE NOT is_test AND NOT is_platform))`;

/**
 * Скачивания и установки (§5.3). Скачивание пишет nginx-зеркало при выдаче APK,
 * запуск — само приложение. Сбой записи не мешает ни скачиванию, ни приложению.
 */
@Injectable()
export class AppInstallsService {
  private readonly log = new Logger('AppInstalls');
  private readonly salt: string;

  constructor(private readonly db: DbService, config: ConfigService) {
    this.salt = `${config.get<string>('JWT_ACCESS_SECRET') ?? 'qevo'}:downloads`;
  }

  async download(uri: string, ip: string, ua: string): Promise<boolean> {
    const hit = parseDownload(uri);
    if (!hit) return false;
    const visitor = createHash('sha256').update(`${this.salt}|${ip}|${ua}`).digest('hex');
    const r = await this.db.query(
      `INSERT INTO app_downloads (file, version, source, visitor, os, bucket)
       VALUES ($1, $2, $3, $4, $5, date_trunc('hour', now()))
       ON CONFLICT (visitor, file, bucket) DO NOTHING`,
      [hit.file, hit.version, hit.source, visitor, osOf(ua)],
    ).catch((e) => { this.log.warn(`скачивание: ${(e as Error).message}`); return null; });
    return (r?.rowCount ?? 0) > 0;
  }

  async launch(m: LaunchReport): Promise<'first_run' | 'update' | 'seen'> {
    return this.db.withTransaction(async (c) => {
      const prev = (await c.query<{ version: string | null }>(
        `SELECT version FROM app_installations WHERE installation_id=$1 FOR UPDATE`, [m.installationId])).rows[0] ?? null;
      const kind = launchKind(prev, m.version ?? null);
      if (!prev) {
        // два первых запуска разом: второй не упадёт и не запишет второй «первый запуск»
        const ins = await c.query(
          `INSERT INTO app_installations (installation_id, platform, channel, first_version, version, os, source, tenant_id)
           VALUES ($1, $2, $3, $4::varchar, $4::varchar, $5, $6, $7) ON CONFLICT (installation_id) DO NOTHING`,
          [m.installationId, m.platform, m.channel || 'stable', m.version ?? null, m.os ?? null, m.source ?? null, m.tenantId ?? null]);
        if (ins.rowCount) {
          await c.query(`INSERT INTO app_install_events (installation_id, kind, to_version) VALUES ($1, 'first_run', $2)`, [m.installationId, m.version ?? null]);
        }
      } else {
        if (kind === 'update') {
          await c.query(`INSERT INTO app_install_events (installation_id, kind, from_version, to_version) VALUES ($1, 'update', $2, $3)`,
            [m.installationId, prev.version, m.version]);
        }
        await c.query(
          `UPDATE app_installations SET version = coalesce($2, version), os = coalesce($3, os),
                  tenant_id = coalesce($4, tenant_id), last_seen_at = now()
            WHERE installation_id=$1`,
          [m.installationId, m.version ?? null, m.os ?? null, m.tenantId ?? null]);
      }
      await c.query(
        `INSERT INTO app_install_days (installation_id, day) VALUES ($1, (now() AT TIME ZONE 'Europe/Moscow')::date)
         ON CONFLICT DO NOTHING`, [m.installationId]);
      return kind;
    });
  }

  /**
   * Показатели за период для консоли владельца. Источники и платформы — раздельно.
   * Пустой источник — «нет данных» (null), а не ноль: учёт начат 02.11.
   */
  async stats(from: string, to: string, tz: string) {
    const lo = `($1::date)::timestamp AT TIME ZONE $3::text`;
    const hi = `($2::date)::timestamp AT TIME ZONE $3::text`;
    const [dl, events, active, has] = await Promise.all([
      this.db.many<{ source: string; n: number }>(
        `SELECT source, count(*)::int AS n FROM app_downloads WHERE created_at >= ${lo} AND created_at < ${hi} GROUP BY source`, [from, to, tz]),
      this.db.many<{ platform: string; first_runs: number; updates: number }>(
        `SELECT i.platform,
                count(*) FILTER (WHERE e.kind='first_run')::int AS first_runs,
                count(*) FILTER (WHERE e.kind='update')::int AS updates
           FROM app_install_events e JOIN app_installations i ON i.installation_id = e.installation_id
          WHERE e.at >= ${lo} AND e.at < ${hi} AND ${NOT_TEST}
          GROUP BY i.platform`, [from, to, tz]),
      this.db.many<{ platform: string; n: number }>(
        `SELECT i.platform, count(DISTINCT d.installation_id)::int AS n
           FROM app_install_days d JOIN app_installations i ON i.installation_id = d.installation_id
          WHERE d.day >= $1::date AND d.day < $2::date AND ${NOT_TEST}
          GROUP BY i.platform`, [from, to]),
      this.db.one<{ downloads: boolean; installs: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM app_downloads) AS downloads, EXISTS (SELECT 1 FROM app_installations) AS installs`),
    ]);
    const byPlatform: Record<string, { firstRuns: number; updates: number; active: number }> = {};
    const slot = (p: string) => (byPlatform[p] ??= { firstRuns: 0, updates: 0, active: 0 });
    for (const r of events) { slot(r.platform).firstRuns = r.first_runs; slot(r.platform).updates = r.updates; }
    for (const r of active) slot(r.platform).active = r.n;
    return {
      since: '2026-11-02',
      downloads: has?.downloads ? { total: dl.reduce((a, r) => a + r.n, 0), bySource: Object.fromEntries(dl.map((r) => [r.source, r.n])) } : null,
      installs: has?.installs ? byPlatform : null,
    };
  }
}
