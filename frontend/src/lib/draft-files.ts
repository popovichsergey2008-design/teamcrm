/**
 * Файлы черновика задачи (#4668) — в IndexedDB этого браузера.
 *
 * localStorage хранит только строки и упирается в 5 МБ, а снимок экрана или макет
 * крупнее. IndexedDB принимает File как есть и переживает обновление страницы и
 * перезапуск приложения. Не вышло (приватное окно, место кончилось) — черновик
 * остаётся без файлов, а окно честно перечисляет, что прикрепить заново.
 */

const DB = 'qevo-task-drafts';
const STORE = 'files';
/** Больше в черновик не кладём: память телефона не резиновая. */
const MAX_BYTES = 60 * 1024 * 1024;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no indexedDB')); return; }
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Сохранить файлы черновика целиком. Вернёт true, если они легли. */
export async function saveDraftFiles(id: string, files: File[]): Promise<boolean> {
  try {
    if (!files.length) { await run('readwrite', (s) => s.delete(id)); return true; }
    if (files.reduce((n, f) => n + f.size, 0) > MAX_BYTES) return false;
    await run('readwrite', (s) => s.put(files, id));
    return true;
  } catch {
    return false;
  }
}

export async function loadDraftFiles(id: string): Promise<File[]> {
  try {
    const v = await run<File[] | undefined>('readonly', (s) => s.get(id) as IDBRequest<File[] | undefined>);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export async function dropDraftFiles(id: string): Promise<void> {
  try { await run('readwrite', (s) => s.delete(id)); } catch { /* нечего удалять */ }
}
