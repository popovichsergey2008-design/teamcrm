/**
 * Перетаскивание островка, кружка и окна заботы (#4636) — чистые правила без React.
 *
 * Положение храним СДВИГОМ от места по умолчанию (справа снизу на ПК, сверху по центру
 * на телефоне), а не координатами угла: так при смене размера окна браузера островок
 * остаётся «у своего угла», а прижатие в видимую область сводится к одной функции.
 */

export interface Offset { dx: number; dy: number }
/** Где стоял бы элемент без сдвига. */
export interface Box { x: number; y: number; w: number; h: number }
export interface View { w: number; h: number }
/** Поля, за которые не заезжаем: системные панели, нижние вкладки, safe-area. */
export interface Insets { top: number; right: number; bottom: number; left: number }

export const ZERO: Offset = { dx: 0, dy: 0 };
/** Меньше — это клик или тап, а не перетаскивание. */
export const DRAG_THRESHOLD = 5;

const r = (v: number) => Math.round(v) || 0; // без «-0»

/**
 * Сдвиг, при котором элемент целиком в видимой области. Не помещается — прижимаем к
 * левому и верхнему полю: у окна там шапка, за которую его тянут обратно.
 */
export function clampOffset(off: Offset, box: Box, view: View, ins: Insets): Offset {
  const minX = ins.left, maxX = view.w - ins.right - box.w;
  const minY = ins.top, maxY = view.h - ins.bottom - box.h;
  const x = maxX < minX ? minX : Math.min(maxX, Math.max(minX, box.x + off.dx));
  const y = maxY < minY ? minY : Math.min(maxY, Math.max(minY, box.y + off.dy));
  return { dx: r(x - box.x), dy: r(y - box.y) };
}

/** Палец или мышь ушли дальше порога — это перетаскивание. */
export function isDrag(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= DRAG_THRESHOLD;
}

/** Клавиатура на ручке: стрелки — шаг 10 px (с Shift — 40), Home — на место. */
export function keyNudge(key: string, shift: boolean): Offset | 'reset' | null {
  const s = shift ? 40 : 10;
  switch (key) {
    case 'ArrowLeft': return { dx: -s, dy: 0 };
    case 'ArrowRight': return { dx: s, dy: 0 };
    case 'ArrowUp': return { dx: 0, dy: -s };
    case 'ArrowDown': return { dx: 0, dy: s };
    case 'Home': return 'reset';
    default: return null;
  }
}

/** Разбор сохранённого: мусор и чужой формат — место по умолчанию. */
export function parseOffset(raw: string | null): Offset {
  try {
    const v = JSON.parse(raw ?? 'null') as Partial<Offset> | null;
    return v && Number.isFinite(v.dx) && Number.isFinite(v.dy) ? { dx: r(v.dx as number), dy: r(v.dy as number) } : ZERO;
  } catch {
    return ZERO;
  }
}
