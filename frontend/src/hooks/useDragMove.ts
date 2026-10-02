import { useRef } from 'react';
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from 'react';

/** С какого сдвига нажатие становится перетаскиванием: дрожание пальца — ещё нажатие. */
const THRESHOLD_PX = 5;

/**
 * Перетаскивание за любое место — в том числе за кнопки.
 *
 * Окно созвона в самом маленьком виде почти целиком состоит из кнопок, и прежнее
 * правило «за кнопки не тянем» делало его неподвижным. Здесь короткое нажатие остаётся
 * нажатием, а движение дальше порога — перетаскиванием; щелчок, которым закончилось
 * перетаскивание, гасится, чтобы кнопка под пальцем не сработала.
 *
 * `begin` снимает исходное состояние (позицию, размеры), `move` получает его вместе
 * со сдвигом указателя и сам решает, куда ставить и где ограничить экраном.
 */
export function useDragMove<T>(
  begin: (el: HTMLElement) => T,
  move: (start: T, dx: number, dy: number) => void,
  opts: { disabled?: boolean; ignore?: (e: ReactPointerEvent<HTMLElement>) => boolean } = {},
) {
  const drag = useRef<{ x: number; y: number; start: T; moved: boolean; id: number } | null>(null);
  const swallowClick = useRef(false);

  const end = () => {
    if (drag.current?.moved) {
      swallowClick.current = true;
      // щелчок, если будет, приходит сразу после отпускания; дальше гасить нечего
      window.setTimeout(() => { swallowClick.current = false; }, 0);
    }
    drag.current = null;
  };

  return {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (opts.disabled) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // в полях ввода тянуть нельзя: там выделяют текст
      if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return;
      if (opts.ignore?.(e)) return;
      drag.current = { x: e.clientX, y: e.clientY, start: begin(e.currentTarget), moved: false, id: e.pointerId };
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved) {
        if (Math.hypot(dx, dy) < THRESHOLD_PX) return;
        d.moved = true;
        try { e.currentTarget.setPointerCapture(d.id); } catch { /* указатель уже отпущен */ }
      }
      e.preventDefault();
      move(d.start, dx, dy);
    },
    onPointerUp: end,
    onPointerCancel: end,
    onClickCapture: (e: ReactMouseEvent<HTMLElement>) => {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      e.stopPropagation();
      e.preventDefault();
    },
  };
}

/** Число в пределах [min, max]; если окно больше экрана — прижимаем к min. */
export const clampTo = (v: number, min: number, max: number) => Math.max(min, Math.min(Math.max(min, max), v));
