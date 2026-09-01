/**
 * Окно поверх всех окон (Document Picture-in-Picture).
 *
 * Так свёрнутый созвон работает в Google Meet, и именно этого не хватало нашей
 * плашке в углу страницы: свернув разговор, человек уходит в другую вкладку или
 * вообще в другую программу — и наша плашка исчезала вместе со вкладкой.
 * Настоящее PiP-окно остаётся на экране поверх всего: собеседник виден, кнопка
 * микрофона под рукой, где бы человек ни работал.
 *
 * Поддерживают Chrome и Edge (116+), Firefox с 151. В Safari API нет — там
 * остаётся плашка внутри страницы, поэтому вызывающий код обязан пережить null.
 *
 * Тонкости, из-за которых окно выходит пустым или без стилей:
 *  - стили в новое окно не переезжают сами, их надо перенести руками;
 *  - тему (`data-theme`) тоже: без неё окно рисуется светлым поверх тёмного CRM;
 *  - открывать можно только в ответ на действие человека — иначе браузер откажет.
 */

interface PipApi {
  requestWindow(options?: { width?: number; height?: number; disallowReturnToOpener?: boolean }): Promise<Window>;
  window: Window | null;
}

function pipApi(): PipApi | null {
  const api = (window as unknown as { documentPictureInPicture?: PipApi }).documentPictureInPicture;
  return api && typeof api.requestWindow === 'function' ? api : null;
}

/** Умеет ли браузер окна поверх всех окон. */
export function pipSupported(): boolean {
  return !!pipApi();
}

/**
 * Открыть окно и перенести в него оформление страницы.
 *
 * Возвращает null, если браузер не умеет или отказал: для вызывающего это не
 * ошибка, а повод показать плашку внутри страницы.
 */
export async function openPipWindow(width: number, height: number): Promise<Window | null> {
  const api = pipApi();
  if (!api) return null;
  try {
    const win = await api.requestWindow({ width, height });
    copyStyles(win);
    copyTheme(win);
    return win;
  } catch {
    // отказ браузера (нет жеста пользователя, окно уже открыто) — не повод падать
    return null;
  }
}

/**
 * Перенос оформления.
 *
 * Клонируем узлы `<style>` и `<link>`, а не читаем cssRules: в сборке стили
 * приходят ссылкой, в разработке — тегом style, и клонирование покрывает оба
 * случая одинаково. Чтение правил вдобавок падает на кросс-доменных файлах.
 */
function copyStyles(win: Window): void {
  document.querySelectorAll('style, link[rel="stylesheet"]').forEach((node) => {
    win.document.head.appendChild(node.cloneNode(true));
  });
  // Тело PiP-окна — не страница: у него нет ни фона приложения, ни отступов по умолчанию.
  const base = win.document.createElement('style');
  base.textContent = 'html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#000;}';
  win.document.head.appendChild(base);
}

/** Тема выбирается в CRM и должна совпадать: окно рядом с приложением, а не само по себе. */
function copyTheme(win: Window): void {
  const theme = document.documentElement.getAttribute('data-theme');
  if (theme) win.document.documentElement.setAttribute('data-theme', theme);
  win.document.documentElement.lang = document.documentElement.lang || 'ru';
}
