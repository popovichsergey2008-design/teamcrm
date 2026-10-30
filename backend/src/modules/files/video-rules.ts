/**
 * Видео (#4692): лимиты и сжатие. Чистые функции — проверяются без хранилища и FFmpeg.
 *
 * Рецепт — из документа заказчика: не выше 720p (меньшее не растягиваем), H.264 CRF 26
 * preset veryfast, звук AAC 96k, +faststart — без него браузер не начнёт показ, пока не
 * скачает файл целиком. Тест заказчика: 80 → 20 МБ.
 */
export const MAX_VIDEO_BYTES = 400 * 1024 * 1024;
/** Мельче этого не жмём: выигрыш копеечный, а процессор общий с CRM. */
export const COMPRESS_MIN_BYTES = 15 * 1024 * 1024;
/** Оригинал после сжатия хранится 2 дня (заказчик 30.10) — потом стирается. */
export const ORIGINAL_KEEP_MS = 2 * 86_400_000;
export const VIDEO_STORAGE_GB_DEFAULT = 100;

/** Записи встреч и голосовые живут своим конвейером (расшифровка) — их не трогаем. */
const OWN_PIPELINE = new Set(['meeting_recording', 'task_audio_proof', 'voice', 'assistant_brief']);

export const isVideo = (contentType: string | null | undefined): boolean => String(contentType ?? '').startsWith('video/');

export function shouldCompress(f: { contentType: string; sizeBytes: number; ownerKind?: string | null }): boolean {
  return isVideo(f.contentType) && f.sizeBytes >= COMPRESS_MIN_BYTES && !OWN_PIPELINE.has(String(f.ownerKind ?? ''));
}

/**
 * Хватит ли места под видео. `usedBytes` — все видео в хранилище, включая ещё не
 * стёртые оригиналы. Отказ — словами для человека.
 */
export function videoSpaceProblem(usedBytes: number, newBytes: number, capGb = VIDEO_STORAGE_GB_DEFAULT): string | null {
  const cap = capGb * 1024 ** 3;
  if (usedBytes + newBytes <= cap) return null;
  return `Место под видео на сервере заполнено (${capGb} ГБ). Сожмите видео перед загрузкой или пришлите ссылкой — например, на Google Диск`;
}

/** Аргументы FFmpeg для сжатия. */
export function compressArgs(input: string, output: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', input,
    // не выше 720 строк; -2 — ширина кратна двум, как требует H.264
    '-vf', "scale=-2:'min(720,ih)'",
    '-c:v', 'libx264', '-crf', '26', '-preset', 'veryfast',
    // два потока: сервер общий, сжатие не должно отнимать процессор у CRM
    '-threads', '2',
    '-c:a', 'aac', '-b:a', '96k',
    '-movflags', '+faststart',
    output,
  ];
}

/** Имя сжатого файла: то же, но .mp4 (контейнер теперь всегда MP4). */
export function compressedName(name: string): string {
  const base = name.replace(/\.[^.\\/]{1,8}$/, '');
  return `${base || 'video'}.mp4`;
}
