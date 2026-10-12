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

/** Страницы, где на экране бывают ключи, пароли, оплата и личные данные (п. 30). */
export function sensitiveRoute(path: string): boolean {
  return /^\/(settings\/(security|integrations|ai-usage|mail|account|team)|profile|console|billing)/.test(path);
}
