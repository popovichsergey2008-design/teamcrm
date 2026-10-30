import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { execFile } from 'child_process';
import { createReadStream, createWriteStream } from 'fs';
import { mkdtemp, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { DbService } from '../../database/db.service';
import { S3Service } from './s3.client';
import { compressArgs, compressedName, ORIGINAL_KEEP_MS, VIDEO_STORAGE_GB_DEFAULT, videoSpaceProblem } from './video-rules';

const run = promisify(execFile);
const TICK_MS = 15_000;
/** Часовое видео на двух потоках жмётся минут 20–30; дольше — что-то не так. */
const FFMPEG_TIMEOUT_MS = 60 * 60_000;
const MAX_ATTEMPTS = 3;

interface JobRow { file_id: string; tenant_id: string; object_key: string; file_name: string; size_bytes: string; attempts: number }

/**
 * Сжатие видео в фоне (#4692).
 *
 * Видео после загрузки играет как есть; здесь его сжимают по одному за раз и кладут
 * сжатую копию на место оригинала у той же строки files — ссылки в чатах и задачах не
 * меняются. Оригинал хранится ORIGINAL_KEEP_MS и стирается уборкой ниже. Не вышло
 * сжать или сжатое не меньше — оставляем оригинал, это не ошибка для человека.
 */
@Injectable()
export class VideoCompressService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('VideoCompress');
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private readonly capGb: number;

  constructor(private readonly db: DbService, private readonly s3: S3Service, config: ConfigService) {
    this.capGb = Number(config.get('VIDEO_STORAGE_GB') ?? VIDEO_STORAGE_GB_DEFAULT) || VIDEO_STORAGE_GB_DEFAULT;
  }

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || process.env.VIDEO_COMPRESS === 'off') return;
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Сколько места занимают видео (с ещё не стёртыми оригиналами). */
  async usedBytes(): Promise<number> {
    const r = await this.db.one<{ n: string }>(
      `SELECT (COALESCE(SUM(size_bytes), 0) + COALESCE(SUM(original_bytes), 0))::text AS n
         FROM files WHERE content_type LIKE 'video/%'`,
    );
    return Number(r?.n ?? 0);
  }

  /** Проверка места перед загрузкой видео; null — место есть. */
  async spaceProblem(newBytes: number): Promise<string | null> {
    return videoSpaceProblem(await this.usedBytes(), newBytes, this.capGb);
  }

  async enqueue(tenantId: string, fileId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO video_jobs (file_id, tenant_id) VALUES ($1, $2) ON CONFLICT (file_id) DO NOTHING`,
      [fileId, tenantId],
    );
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.cleanupOriginals();
      await this.processOne();
    } catch (e) {
      this.log.warn(`проход: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  /** Стереть оригиналы, срок которых вышел. */
  async cleanupOriginals(now = new Date()): Promise<number> {
    const rows = await this.db.many<{ id: string; original_key: string }>(
      `SELECT id::text, original_key FROM files
        WHERE original_delete_at IS NOT NULL AND original_delete_at <= $1 AND original_key IS NOT NULL
        LIMIT 50`,
      [now],
    );
    for (const r of rows) {
      await this.s3.client.send(new DeleteObjectCommand({ Bucket: this.s3.bucket, Key: r.original_key })).catch(() => undefined);
      await this.db.query(
        `UPDATE files SET original_key = NULL, original_bytes = NULL, original_delete_at = NULL WHERE id = $1`, [r.id],
      );
    }
    return rows.length;
  }

  /** Взять одну задачу из очереди и сжать. Публичный — для ручного прогона и тестов. */
  async processOne(): Promise<'done' | 'skipped' | 'failed' | null> {
    const job = await this.db.one<JobRow>(
      `UPDATE video_jobs j SET status = 'running', started_at = now(), attempts = attempts + 1
        WHERE j.file_id = (
          SELECT file_id FROM video_jobs
           WHERE (status = 'pending' OR (status = 'running' AND started_at < now() - interval '2 hours'))
             AND attempts < ${MAX_ATTEMPTS}
           ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING j.file_id::text, j.tenant_id::text, j.attempts,
                 (SELECT object_key FROM files WHERE id = j.file_id) AS object_key,
                 (SELECT file_name FROM files WHERE id = j.file_id) AS file_name,
                 (SELECT size_bytes::text FROM files WHERE id = j.file_id) AS size_bytes`,
    );
    if (!job || !job.object_key) return null;

    const dir = await mkdtemp(join(tmpdir(), 'qevo-video-'));
    const input = join(dir, 'in');
    const output = join(dir, 'out.mp4');
    try {
      const obj = await this.s3.client.send(new GetObjectCommand({ Bucket: this.s3.bucket, Key: job.object_key }));
      await pipeline(obj.Body as Readable, createWriteStream(input));
      // nice: сжатие уступает процессор запросам людей
      await run('nice', ['-n', '19', 'ffmpeg', ...compressArgs(input, output)], { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 1 << 20 });
      const before = Number(job.size_bytes);
      const after = (await stat(output)).size;
      if (!after || after >= before * 0.95) {
        await this.finish(job.file_id, 'skipped', `сжатое не меньше: ${after} из ${before}`);
        return 'skipped';
      }
      const name = compressedName(job.file_name);
      const key = `${job.tenant_id}/${randomUUID()}/${name}`;
      await this.s3.client.send(new PutObjectCommand({
        Bucket: this.s3.bucket, Key: key, Body: createReadStream(output), ContentType: 'video/mp4', ContentLength: after,
      }));
      // строка могла исчезнуть, пока жали (файл удалили) — тогда сжатое не нужно
      const swapped = await this.db.one<{ id: string }>(
        `UPDATE files SET object_key = $2, file_name = $3, content_type = 'video/mp4', size_bytes = $4,
                original_key = object_key, original_bytes = size_bytes,
                original_delete_at = now() + ($5 || ' milliseconds')::interval, compressed_at = now()
          WHERE id = $1 AND object_key = $6 RETURNING id::text`,
        [job.file_id, key, name, after, String(ORIGINAL_KEEP_MS), job.object_key],
      );
      if (!swapped) {
        await this.s3.client.send(new DeleteObjectCommand({ Bucket: this.s3.bucket, Key: key })).catch(() => undefined);
        await this.finish(job.file_id, 'skipped', 'файл удалили во время сжатия');
        return 'skipped';
      }
      await this.finish(job.file_id, 'done', null);
      this.log.log(`файл ${job.file_id}: ${Math.round(before / 1048576)} → ${Math.round(after / 1048576)} МБ`);
      return 'done';
    } catch (e) {
      const msg = (e as Error).message.slice(0, 500);
      this.log.warn(`файл ${job.file_id}: ${msg}`);
      await this.finish(job.file_id, job.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', msg);
      return 'failed';
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async finish(fileId: string, status: string, error: string | null): Promise<void> {
    await this.db.query(
      `UPDATE video_jobs SET status = $2, last_error = $3, finished_at = CASE WHEN $4::boolean THEN now() END
        WHERE file_id = $1`,
      [fileId, status, error, status !== 'pending'],
    );
  }
}
