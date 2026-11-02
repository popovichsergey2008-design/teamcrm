import { Injectable } from '@nestjs/common';
import { promises as fs } from 'fs';
import { join } from 'path';
import { DbService } from '../../database/db.service';
import { HealthService } from '../health/health.service';
import { BUILD } from '../../common/build-info';

const STARTED_AT = new Date().toISOString();

/**
 * Техническое состояние для консоли разработчика (§4). Только метаданные: статусы,
 * счётчики, возраст заданий, тексты ошибок обработчиков. Содержимое писем, голосовых
 * и файлов не отдаём — для диагностики хватает «сколько, какого возраста, почему упало».
 */
@Injectable()
export class PcDevService {
  constructor(private readonly db: DbService, private readonly health: HealthService) {}

  private queues() {
    return this.db.many<{ queue: string; status: string; n: number; oldest_min: number | null; last_error: string | null }>(
      `SELECT 'Письма и уведомления' AS queue, status, count(*)::int AS n,
              (extract(epoch FROM now() - min(created_at)) / 60)::int AS oldest_min,
              (array_agg(left(last_error, 200) ORDER BY updated_at DESC) FILTER (WHERE last_error IS NOT NULL))[1] AS last_error
         FROM mail_outbox WHERE status <> 'sent' OR created_at > now() - interval '1 day' GROUP BY status
       UNION ALL
       SELECT 'Сжатие видео', status, count(*)::int, (extract(epoch FROM now() - min(created_at)) / 60)::int,
              (array_agg(left(last_error, 200) ORDER BY created_at DESC) FILTER (WHERE last_error IS NOT NULL))[1]
         FROM video_jobs WHERE status NOT IN ('done') OR created_at > now() - interval '1 day' GROUP BY status
       UNION ALL
       SELECT 'Голосовые задачи', status, count(*)::int, (extract(epoch FROM now() - min(created_at)) / 60)::int,
              (array_agg(left(error, 200) ORDER BY updated_at DESC) FILTER (WHERE error IS NOT NULL))[1]
         FROM voice_jobs WHERE created_at > now() - interval '7 days' GROUP BY status
       UNION ALL
       SELECT 'Синхронизация интеграций', status, count(*)::int, (extract(epoch FROM now() - min(created_at)) / 60)::int,
              (array_agg(left(last_error, 200) ORDER BY updated_at DESC) FILTER (WHERE last_error IS NOT NULL))[1]
         FROM integration_outbox WHERE status <> 'done' OR created_at > now() - interval '1 day' GROUP BY status
       ORDER BY 1, 2`);
  }

  /** Падения приложения за неделю, сгруппированные по версии и тексту ошибки. */
  private crashes() {
    return this.db.many<{ version: string; message: string; n: number; users: number; last_at: Date }>(
      `SELECT coalesce(ref_id, '—') AS version, left(coalesce(data->>'message', data->>'error', 'без текста'), 200) AS message,
              count(*)::int AS n, count(DISTINCT user_id)::int AS users, max(created_at) AS last_at
         FROM diag_events
        WHERE scope='app' AND event='crash' AND created_at > now() - interval '7 days'
        GROUP BY 1, 2 ORDER BY max(created_at) DESC LIMIT 50`);
  }

  private async size() {
    return this.db.one<{ db_bytes: string; files_bytes: string; files: number }>(
      `SELECT pg_database_size(current_database())::text AS db_bytes,
              coalesce((SELECT sum(size_bytes) FROM files), 0)::text AS files_bytes,
              (SELECT count(*) FROM files)::int AS files`).catch(() => null);
  }

  async status() {
    const [health, queues, crashes, size] = await Promise.all([this.health.check(), this.queues(), this.crashes(), this.size()]);
    return {
      env: process.env.APP_ENV ?? (process.env.NODE_ENV === 'production' ? 'production' : 'dev'),
      health,
      build: { ...BUILD, startedAt: STARTED_AT, color: process.env.DEPLOY_COLOR ?? null },
      queues,
      crashes,
      storage: size && { dbBytes: Number(size.db_bytes), filesBytes: Number(size.files_bytes), files: size.files },
      generatedAt: new Date().toISOString(),
    };
  }

  /** История выпусков (§4.2, §8): пишет deploy/release.sh, здесь только чтение. */
  releases() {
    return this.db.many<{ id: string; sha: string; run: string | null; author: string | null; subject: string | null; color: string | null;
      status: string; dev_result: string | null; prod_result: string | null; started_at: Date; finished_at: Date | null }>(
      `SELECT id::text, sha, run, author, subject, color, status, dev_result, prod_result, started_at, finished_at
         FROM release_versions ORDER BY started_at DESC LIMIT 50`).catch(() => []);
  }

  /**
   * Резервные копии базы (§4.2): последняя ежедневная и еженедельная, размер, возраст.
   * Каталог смонтирован только для чтения. Копии лежат на этом же сервере — консоль
   * говорит это прямо: при потере сервера они пропадут вместе с ним.
   */
  async backups() {
    const dir = process.env.BACKUPS_DIR || '/srv/backups';
    let names: string[];
    try { names = (await fs.readdir(dir)).filter((n) => n.endsWith('.dump')); } catch { return null; }
    const files = await Promise.all(names.map(async (n) => {
      const st = await fs.stat(join(dir, n)).catch(() => null);
      return st ? { name: n, bytes: st.size, at: st.mtime.toISOString(), weekly: n.startsWith('weekly-') } : null;
    }));
    const list = files.filter((f): f is NonNullable<typeof f> => !!f).sort((a, b) => b.at.localeCompare(a.at));
    const daily = list.filter((f) => !f.weekly);
    const weekly = list.filter((f) => f.weekly);
    const last = daily[0] ?? null;
    return {
      lastDaily: last, lastWeekly: weekly[0] ?? null, dailyCount: daily.length, weeklyCount: weekly.length,
      totalBytes: list.reduce((a, f) => a + f.bytes, 0),
      // ежедневная копия старше 26 часов — пропуск, а не «ещё не время»
      stale: !last || Date.now() - Date.parse(last.at) > 26 * 3600_000,
      offsite: false,
    };
  }
}
