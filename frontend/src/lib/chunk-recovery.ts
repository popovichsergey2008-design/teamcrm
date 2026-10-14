/**
 * Белый экран после выкладки (14.10, «мега срочно»).
 *
 * Приложение грузит разделы кусками по мере перехода. Выложили новую версию —
 * у человека открыта вкладка прежней, он идёт в раздел, которого ещё не открывал,
 * и браузер просит кусок старой сборки. Если его на сервере уже нет — импорт падает,
 * и без перехвата от приложения остаётся пустой фон. Сервер теперь хранит прежнюю
 * сборку (deploy/release.sh), а здесь — страховка: такой сбой лечится одним
 * обновлением страницы. Обновляем сами, но не чаще раза в минуту — чтобы настоящая
 * поломка не превратилась в бесконечную перезагрузку.
 */

const KEY = 'qevo.chunk-reload-at';

/** Ошибка загрузки куска сборки — у каждого браузера свои слова. */
export function isChunkError(e: unknown): boolean {
  const msg = String((e as { message?: string } | null)?.message ?? e ?? '');
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError|Unable to preload CSS|Loading chunk \d+ failed|Loading CSS chunk/i.test(msg);
}

/** Обновить страницу один раз; true — обновление запущено. */
export function reloadOnce(): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch { /* хранилище недоступно — всё равно пробуем один раз */ }
  window.location.reload();
  return true;
}

export function installChunkRecovery(): void {
  // Vite сам сообщает о сбое подгрузки куска — по нему и обновляемся
  window.addEventListener('vite:preloadError', (ev) => {
    if (reloadOnce()) ev.preventDefault();
  });
  window.addEventListener('unhandledrejection', (ev) => {
    if (isChunkError((ev as PromiseRejectionEvent).reason)) reloadOnce();
  });
}
