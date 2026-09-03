/**
 * Вложения в переписке: имена, типы, размеры.
 *
 * Правила чистые и потому проверяются тестами: ошибаются они молча. Скриншот из
 * буфера приходит без имени — если не дать ему осмысленное, в чате и в списке файлов
 * копится десяток одинаковых «image.png», и найти нужный нельзя.
 */

/** Расширение по типу: браузер кладёт в буфер png, но вставить могут и jpeg. */
const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/heic': 'heic',
};

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tiff', 'heic', 'heif', 'svg']);

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Имя для скриншота из буфера обмена.
 *
 * Дата и время, а не случайный набор: человек ищет вложение по тому, когда его
 * прислали, — «вчера после созвона», а не «файл 7f3a».
 */
export function screenshotName(d: Date, mime: string): string {
  const ext = EXT[mime] ?? 'png';
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `Снимок ${date} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.${ext}`;
}

/**
 * Имя, которое ничего не значит.
 *
 * Буфер обмена отдаёт скриншот как «image.png» (а кое-где вовсе без имени) —
 * такое имя переименовываем. Осмысленное не трогаем: файл, названный человеком или
 * системой («Снимок экрана 2026-09-01.png»), переименовывать не наше дело.
 */
export function isAnonymousClipboardName(name: string | null | undefined): boolean {
  const n = String(name ?? '').trim();
  return !n || /^(image|blob|unknown|paste)(\.[a-z0-9]+)?$/i.test(n);
}

/** Картинку в переписке показываем сразу, остальное — строкой со скрепкой. */
export function isImageName(name: string | null | undefined): boolean {
  const m = /\.([a-z0-9]+)$/i.exec(String(name ?? '').trim());
  return !!m && IMAGE_EXT.has(m[1].toLowerCase());
}

const AUDIO_EXT = new Set(['webm', 'ogg', 'oga', 'mp3', 'm4a', 'wav', 'flac']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'mkv', 'avi', 'mpeg']);

/**
 * Что проигрывается прямо в ленте, а что скачивается.
 *
 * Голосовое и запись экрана обязаны играть на месте: ссылка «скачать запись» превращает
 * клип в документ, который надо сохранить, найти в загрузках и открыть плеером — ради
 * двадцати секунд объяснения этого никто не делает.
 *
 * webm двусмыслен: в нём и голос, и видео с экрана. По расширению их не различить,
 * поэтому голосовые отправляются с говорящим именем, а всё остальное webm считаем видео —
 * ошибиться в эту сторону безопаснее: плеер видео проигрывает и звук.
 */
export function isPlayableName(name: string | null | undefined): 'audio' | 'video' | null {
  const raw = String(name ?? '').trim();
  const m = /\.([a-z0-9]+)$/i.exec(raw);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  if (VIDEO_EXT.has(ext)) return 'video';
  if (ext === 'webm') return /голосов/i.test(raw) ? 'audio' : 'video';
  return AUDIO_EXT.has(ext) ? 'audio' : null;
}

/** Размер по-человечески: «348 КБ», «1.2 МБ». */
export function humanSize(bytes: number): string {
  const b = Math.max(0, Number(bytes) || 0);
  if (b < 1024) return `${b} Б`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} КБ`;
  return `${(b / (1024 * 1024)).toFixed(1)} МБ`;
}
