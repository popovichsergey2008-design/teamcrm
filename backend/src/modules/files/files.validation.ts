/** Валидация и санитизация загружаемых файлов (Enhancements v1, Этап A). Чистые функции. */

export const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 МБ

const ALLOWED = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp', 'image/tiff', 'image/heic',
  'video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo', 'video/x-matroska', 'video/mpeg',
  // audio/webm — то, чем пишет браузер: без него не сохранялась собственная надиктовка
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/mp4', 'audio/webm', 'audio/x-m4a', 'audio/flac',
  'application/pdf', 'text/plain', 'text/csv', 'text/markdown',
  'application/zip', 'application/x-zip-compressed',
  // Архивы, которые шлют вместе со снимком: раньше один такой файл ронял ВСЁ сообщение.
  'application/vnd.rar', 'application/x-rar-compressed', 'application/x-7z-compressed',
  'application/x-tar', 'application/gzip', 'application/x-gzip',
  // Тип, которым браузер помечает всё незнакомое (.dwg, .psd, .sql, файл без расширения).
  // Отдаём такие только вложением (см. files.controller), поэтому опасности не добавляют.
  'application/octet-stream',
  'application/json', 'application/xml', 'text/xml', 'text/html', 'application/rtf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

export interface ValidationError {
  ok: false;
  reason: string;
}
export interface ValidationOk {
  ok: true;
}

/**
 * Проверка одного файла.
 *
 * Сообщение об отказе читает человек, а не разработчик: он приложил к снимку договор
 * и получил «content-type not allowed» — из этого не следует, что делать. Поэтому
 * называем сам файл и говорим по-русски; имя необязательное, чтобы старые вызовы
 * не переписывать.
 */
export function validateUpload(
  contentType: string, sizeBytes: number, maxBytes = MAX_FILE_BYTES, fileName?: string,
): ValidationOk | ValidationError {
  const who = fileName ? `«${fileName}»: ` : '';
  const mb = Math.round(maxBytes / (1024 * 1024));
  if (sizeBytes <= 0) return { ok: false, reason: `${who}пустой файл` };
  if (sizeBytes > maxBytes) return { ok: false, reason: `${who}файл больше ${mb} МБ` };
  if (!ALLOWED.has(contentType)) return { ok: false, reason: `${who}такой тип файла не принимаем (${contentType})` };
  return { ok: true };
}

/**
 * Починка имени файла, приехавшего из multipart.
 *
 * Браузер шлёт имя в UTF-8, но multipart-разбор отдаёт его побайтово как latin1,
 * и «условия.txt» превращается в «ÑÑÐ»Ð¾Ð²Ð¸Ñ.txt». До сих пор это никто не замечал,
 * потому что в списке вложений имя показывалось таким же искажённым с обеих сторон,
 * а всплыло, когда файлы попали в поиск.
 *
 * Трогаем только то, что похоже на такую подмену: строку без настоящих юникод-символов,
 * но с байтами 0x80–0xFF. Правильное имя («Отчёт.docx») содержит символы выше 0x00FF
 * и остаётся нетронутым — иначе мы бы ломали то, что и так верно.
 */
export function decodeUploadName(name: string): string {
  if (!name) return name;
  if (!/[-ÿ]/.test(name)) return name;   // чистый ASCII — чинить нечего
  if (/[Ā-￿]/.test(name)) return name;    // есть настоящий юникод — имя уже верное
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.includes('�') ? name : decoded; // не разобралось — оставляем как есть
}

/** Безопасное имя файла: убираем путь и опасные символы. */
export function sanitizeFileName(name: string): string {
  const base = (name || 'file').split(/[\\/]/).pop() || 'file';
  // разрешаем Unicode-буквы/цифры (кириллица и т.п.), убираем только опасные символы
  // «№» разрешён намеренно: в русских документах он в каждом втором названии
  // («Договор №415.pdf»), а опасности в имени файла не несёт.
  const cleaned = base.replace(/[^\p{L}\p{N}._\-№ ()]/gu, '_').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 180) || 'file';
}
