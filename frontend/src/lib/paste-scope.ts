/**
 * Кому достаётся вставленный из буфера снимок.
 *
 * Живая жалоба: «делаю скрин из чата, иду ставить задачу, вставляю — а скрин уходит
 * в тот чат, из которого я только что вышел». Так и было: и переписка, и лента задачи
 * слушают вставку на ВСЁМ окне (человек жмёт Ctrl+V, не целясь в поле ввода), и окно
 * чата остаётся в разметке, когда поверх него открыли создание задачи. Оба слушателя
 * срабатывали, первым — чужой.
 *
 * Правило простое и то же, что у клавиши Esc: снимок достаётся самому верхнему
 * открытому слою. Слои помечают себя `data-paste-scope`; если поверх нашего слоя
 * открыт другой, мы молчим.
 *
 * Чистая функция внизу — её проверяет logic-check.
 */

/** Слои, которые перекрывают собой переписку. Порядок не важен — важен сам факт. */
export const OVERLAY_SELECTOR = '[data-paste-scope], .modal-overlay, .drawer-overlay, .palette-overlay, .sheet-overlay';

/**
 * Наш ли это слой. `scopes` — все открытые слои в порядке разметки (снизу вверх),
 * `mine` — наш. Верхний слой и есть самый поздно открытый: браузер добавляет их в конец.
 */
export function topmostIsMine(scopes: readonly unknown[], mine: unknown): boolean {
  if (!scopes.length) return true;           // слоёв нет вовсе — вставка наша
  if (!mine) return false;                   // наш слой не нашёлся, а чужой открыт
  return scopes[scopes.length - 1] === mine;
}

/**
 * Обрабатывать ли вставку в этом слое. `el` — любой узел внутри нашего слоя
 * (поле ввода, лента); null — слоя нет, значит мы на самой странице.
 */
export function pasteBelongsHere(el: Element | null): boolean {
  try {
    const scopes = Array.from(document.querySelectorAll(OVERLAY_SELECTOR));
    const mine = el ? el.closest(OVERLAY_SELECTOR) : null;
    return topmostIsMine(scopes, mine);
  } catch {
    return true; // не смогли разобраться — лучше вставить, чем потерять снимок
  }
}
