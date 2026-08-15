import { execFile } from 'child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const run = promisify(execFile);

/** Кусок записи: сам звук и его смещение от начала встречи (для сшивки стенограммы). */
export interface AudioChunk {
  buffer: Buffer;
  offsetSec: number;
  name: string;
}

/**
 * Часовая запись не влезает ни в наш лимит загрузки, ни в лимит Whisper (25 МБ на запрос),
 * поэтому звук приводится к моно 16 кГц 32 кбит/с и режется на куски по 10 минут:
 * кусок весит ~2.5 МБ — с большим запасом. Whisper всё равно работает на 16 кГц,
 * так что понижение качества на распознавание не влияет, а трафик экономит кратно.
 */
export const CHUNK_SECONDS = 600;

export async function probeDurationSec(file: string): Promise<number> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
  ], { timeout: 120_000 });
  const v = Number(String(stdout).trim());
  return Number.isFinite(v) ? Math.round(v) : 0;
}

/**
 * Извлекает аудиодорожку (видео отбрасывается) и режет её на куски.
 * Возвращает куски и общую длительность; временные файлы удаляются.
 */
export async function extractAudioChunks(
  source: Buffer,
  fileName: string,
  chunkSeconds = CHUNK_SECONDS,
): Promise<{ chunks: AudioChunk[]; durationSec: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'meeting-'));
  const ext = (fileName.split('.').pop() || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
  const input = join(dir, `input.${ext}`);
  try {
    await writeFile(input, source);
    const durationSec = await probeDurationSec(input).catch(() => 0);

    await run('ffmpeg', [
      '-i', input,
      '-vn',                      // видео не нужно: ИИ работает со звуком
      '-ac', '1', '-ar', '16000', // моно 16 кГц — родной формат распознавания
      '-c:a', 'libmp3lame', '-b:a', '32k',
      '-f', 'segment', '-segment_time', String(chunkSeconds), '-reset_timestamps', '1',
      join(dir, 'part_%03d.mp3'),
    ], { timeout: 30 * 60_000, maxBuffer: 1 << 20 });

    const parts = (await readdir(dir)).filter((f) => f.startsWith('part_')).sort();
    const chunks: AudioChunk[] = [];
    for (const [i, name] of parts.entries()) {
      chunks.push({ buffer: await readFile(join(dir, name)), offsetSec: i * chunkSeconds, name });
    }
    return { chunks, durationSec };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Понятная причина вместо «spawn ffmpeg ENOENT» в статусе встречи. */
export function describeFfmpegError(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e);
  if (/ENOENT/.test(msg)) return 'На сервере нет ffmpeg — обработка записей недоступна';
  return `Не удалось обработать запись: ${msg.slice(0, 300)}`;
}
