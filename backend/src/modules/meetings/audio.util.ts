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

/**
 * Сведение дорожек созвона в одну запись (ТЗ-21, этап 4). Дорожки пишутся по человеку и
 * начинаются в разное время — каждой задержка на её смещение от начала, потом смесь.
 * amix делит громкость на число входов — возвращаем её обратно, иначе вдвоём тише вдвое.
 * MP3 моно 32 кбит/с — тем же кодеком, что режем для распознавания: он точно есть в сборке.
 */
export function mixArgs(inputs: { file: string; offsetSec: number }[], out: string): string[] {
  const args: string[] = [];
  for (const i of inputs) args.push('-i', i.file);
  const n = inputs.length;
  const chains = inputs.map((i, k) => `[${k}:a]aresample=24000,adelay=delays=${Math.max(0, Math.round(i.offsetSec * 1000))}:all=1[a${k}]`);
  const mix = n > 1
    ? `${inputs.map((_, k) => `[a${k}]`).join('')}amix=inputs=${n}:duration=longest:dropout_transition=0,volume=${n}[out]`
    : `[a0]anull[out]`;
  args.push('-filter_complex', [...chains, mix].join(';'), '-map', '[out]', '-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', '32k', '-y', out);
  return args;
}

export async function mixTracks(tracks: { buffer: Buffer; fileName: string; offsetSec: number }[]): Promise<Buffer | null> {
  if (!tracks.length) return null;
  const dir = await mkdtemp(join(tmpdir(), 'mix-'));
  try {
    const inputs: { file: string; offsetSec: number }[] = [];
    for (const [k, t] of tracks.entries()) {
      const ext = (t.fileName.split('.').pop() || 'ogg').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'ogg';
      const file = join(dir, `t${k}.${ext}`);
      await writeFile(file, t.buffer);
      inputs.push({ file, offsetSec: t.offsetSec });
    }
    const out = join(dir, 'mix.mp3');
    await run('ffmpeg', mixArgs(inputs, out), { timeout: 30 * 60_000, maxBuffer: 1 << 20 });
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Аргументы ffmpeg для фрагмента: моно, 64 кбит/с mp3 — речь разборчива, 15 секунд ≈ 120 КБ. */
export function clipArgs(input: string, startSec: number, endSec: number, out: string): string[] {
  const dur = Math.max(1, endSec - startSec);
  return ['-hide_banner', '-loglevel', 'error', '-y', '-ss', startSec.toFixed(2), '-t', dur.toFixed(2), '-i', input,
    '-vn', '-ac', '1', '-codec:a', 'libmp3lame', '-b:a', '64k', out];
}

/**
 * Вырезать фрагменты из одной записи за одно скачивание (ТЗ-25): пять задач со встречи —
 * пять фрагментов, а запись встречи тянется из хранилища один раз.
 */
export async function cutClips(source: Buffer, sourceName: string, ranges: { startSec: number; endSec: number }[]): Promise<(Buffer | null)[]> {
  if (!ranges.length) return [];
  const dir = await mkdtemp(join(tmpdir(), 'clip-'));
  try {
    const ext = (sourceName.split('.').pop() || 'mp3').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'mp3';
    const input = join(dir, `src.${ext}`);
    await writeFile(input, source);
    const out: (Buffer | null)[] = [];
    for (const [k, r] of ranges.entries()) {
      const file = join(dir, `c${k}.mp3`);
      try {
        await run('ffmpeg', clipArgs(input, r.startSec, r.endSec, file), { timeout: 120_000, maxBuffer: 1 << 20 });
        out.push(await readFile(file));
      } catch {
        out.push(null); // этот фрагмент не вышел — остальные режем дальше
      }
    }
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
