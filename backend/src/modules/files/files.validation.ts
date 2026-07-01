/** Валидация и санитизация загружаемых файлов (Enhancements v1, Этап A). Чистые функции. */

export const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 МБ

const ALLOWED = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
  'application/pdf', 'text/plain', 'text/csv', 'text/markdown',
  'application/zip', 'application/x-zip-compressed',
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

export function validateUpload(contentType: string, sizeBytes: number): ValidationOk | ValidationError {
  if (sizeBytes <= 0) return { ok: false, reason: 'empty file' };
  if (sizeBytes > MAX_FILE_BYTES) return { ok: false, reason: `file too large (>${MAX_FILE_BYTES} bytes)` };
  if (!ALLOWED.has(contentType)) return { ok: false, reason: `content-type not allowed: ${contentType}` };
  return { ok: true };
}

/** Безопасное имя файла: убираем путь и опасные символы. */
export function sanitizeFileName(name: string): string {
  const base = (name || 'file').split(/[\\/]/).pop() || 'file';
  // разрешаем Unicode-буквы/цифры (кириллица и т.п.), убираем только опасные символы
  const cleaned = base.replace(/[^\p{L}\p{N}._\- ()]/gu, '_').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 180) || 'file';
}
