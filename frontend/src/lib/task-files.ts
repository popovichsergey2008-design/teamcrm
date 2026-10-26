import { api, ApiError } from './api';
import { isAnonymousClipboardName, screenshotName } from './attachments';

/**
 * Файлы к только что созданной задаче (#4664).
 *
 * Вложение живёт при задаче, а до создания её нет — поэтому окна постановки держат
 * выбранные файлы у себя и отдают их сюда сразу после создания. Грузим по одному и по
 * порядку: десяток вложений, отправленных разом с телефона, рвётся на середине, и
 * потом не понять, что именно не долетело. Причину отказа сохраняем: «не загрузились»
 * без слова «почему» человек не может исправить.
 */
export interface FileFailure { name: string; reason: string }

/** Сервер принимает до 25 МБ на файл (backend files.validation): больше — не шлём зря. */
export const MAX_TASK_FILE_BYTES = 25 * 1024 * 1024;

export async function uploadTaskFiles(
  taskId: string,
  files: File[],
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<FileFailure[]> {
  const failed: FileFailure[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    onProgress?.(i, files.length, f.name);
    if (f.size > MAX_TASK_FILE_BYTES) { failed.push({ name: f.name, reason: 'больше 25 МБ' }); continue; }
    try { await api.uploadAttachment(taskId, f); }
    catch (e) { failed.push({ name: f.name, reason: e instanceof ApiError ? e.message : 'сеть оборвалась' }); }
  }
  onProgress?.(files.length, files.length, '');
  return failed;
}

/** «a.png (больше 25 МБ); b.pdf (нет связи)» — для строки ошибки. */
export function describeFailures(list: FileFailure[]): string {
  return list.map((f) => `${f.name} (${f.reason})`).join('; ');
}

/** Добавить файлы без повторов: человек выбирает файл дважды чаще, чем прикладывает два одинаковых. */
export function mergeFiles(prev: File[], list: FileList | File[] | null | undefined): File[] {
  if (!list?.length) return prev;
  const seen = new Set(prev.map((f) => `${f.name}:${f.size}`));
  return [...prev, ...Array.from(list).filter((f) => !seen.has(`${f.name}:${f.size}`))];
}

/** Картинки из буфера (Ctrl+V): «image.png» превращается в дату и время снимка. */
export function pastedImages(data: DataTransfer | null): File[] {
  return Array.from(data?.files ?? [])
    .filter((f) => f.type.startsWith('image/'))
    .map((f) => (isAnonymousClipboardName(f.name) ? new File([f], screenshotName(new Date(), f.type), { type: f.type }) : f));
}
