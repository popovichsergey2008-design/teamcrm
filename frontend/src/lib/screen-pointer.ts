/**
 * Подсветка на показанном экране (ТЗ-29, п. 18) — только картинка, не управление.
 *
 * Инженер щёлкает по чужому показу, мы переводим точку в доли кадра (0..1) с учётом
 * полей по краям (видео вписано в рамку), у показывающего рисуем круг.
 */
export interface PointerMark {
  id: string;
  x: number;
  y: number;
  kind: string;
  name: string;
  /** рисовать поверх страницы (показана эта вкладка) или только словами в окне созвона */
  page: boolean;
  /** своя отметка — эхо у того, кто щёлкнул */
  local?: boolean;
}

/** Точка щелчка в долях КАДРА: поля вокруг вписанного видео не считаются. */
export function videoPoint(v: HTMLVideoElement, clientX: number, clientY: number): { x: number; y: number } | null {
  const r = v.getBoundingClientRect();
  const vw = v.videoWidth || r.width;
  const vh = v.videoHeight || r.height;
  if (!vw || !vh || !r.width || !r.height) return null;
  const scale = Math.min(r.width / vw, r.height / vh);
  const cw = vw * scale, ch = vh * scale;
  const ox = r.left + (r.width - cw) / 2, oy = r.top + (r.height - ch) / 2;
  const x = (clientX - ox) / cw, y = (clientY - oy) / ch;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 };
}

/** Где на экране — словами, когда нарисовать поверх нельзя (показан весь экран или другое окно). */
export function pointerWhere(x: number, y: number): string {
  const v = y < 0.33 ? 'вверху' : y > 0.66 ? 'внизу' : 'посередине';
  const h = x < 0.33 ? 'слева' : x > 0.66 ? 'справа' : 'по центру';
  return v === 'посередине' && h === 'по центру' ? 'в центре экрана' : `${v} ${h}`;
}

/**
 * Нажать за показывающего (ТЗ-34, 3.3): точка в долях окна → элемент под ней → click.
 *
 * Только с разрешения показывающего и только по ЭТОЙ вкладке (проверяет вызывающий).
 * Не нажимаем окно созвона (инженер не должен иметь возможности выключить показ или
 * повесить трубку), поля паролей и чувствительные страницы. Возвращает подпись нажатого
 * для журнала или null, если нажимать было нечего или нельзя.
 */
export function tapAt(x: number, y: number): string | null {
  if (sensitiveRoute(window.location.pathname)) return null;
  const at = document.elementFromPoint(x * window.innerWidth, y * window.innerHeight) as HTMLElement | null;
  if (!at || at.closest('.call-window, .call-overlay, .call-mini, .ptr-layer')) return null;
  const el = (at.closest('button, a[href], [role="button"], input, select, textarea, label, summary, [tabindex]') as HTMLElement | null) ?? at;
  if (el instanceof HTMLInputElement && el.type === 'password') return null;
  el.focus?.({ preventScroll: true });
  el.click();
  return (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || el.tagName.toLowerCase())
    .replace(/\s+/g, ' ').trim().slice(0, 60);
}

/** Страницы, где на экране бывают ключи, пароли, оплата и личные данные (п. 30). */
export function sensitiveRoute(path: string): boolean {
  return /^\/(settings\/(security|integrations|ai-usage|mail|account|team)|profile|console|billing)/.test(path);
}
