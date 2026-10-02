import { useEffect, useRef } from 'react';
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
 * Движение слушаем на всём окне, а не на самом элементе: маленькая кнопка уходит из-под
 * указателя на первом же рывке, и слушай мы только её — она бы так и не сдвинулась.
 * Захват указателя (setPointerCapture) здесь не подходит: с ним щелчок уходит
 * контейнеру, и кнопки внутри перестают нажиматься.
 *
 * `begin` снимает исходное состояние (позицию, размеры), `move` получает его вместе
 * со сдвигом указателя и сам решает, куда ставить и где ограничить экраном.
 */
export function useDragMove<T>(
  begin: (el: HTMLElement) => T,
  move: (start: T, dx: number, dy: number) => void,
  opts: { disabled?: boolean; ignore?: (e: ReactPointerEvent<HTMLElement>) => boolean } = {},
) {
  const swallowClick = useRef(false);
  const stop = useRef<(() => void) | null>(null);
  // свежие обработчики без пересоздания слушателей посреди перетаскивания
  const moveRef = useRef(move);
  moveRef.current = move;

  useEffect(() => () => stop.current?.(), []);

  return {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (opts.disabled) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // в полях ввода тянуть нельзя: там выделяют текст
      if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return;
      if (opts.ignore?.(e)) return;
      stop.current?.();
      const x0 = e.clientX; const y0 = e.clientY; const id = e.pointerId;
      const start = begin(e.currentTarget);
      let moved = false;
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== id) return;
        const dx = ev.clientX - x0; const dy = ev.clientY - y0;
        if (!moved) {
          if (Math.hypot(dx, dy) < THRESHOLD_PX) return;
          moved = true;
          document.body.classList.add('is-dragging');
        }
        ev.preventDefault();
        moveRef.current(start, dx, dy);
      };
      const onEnd = (ev: PointerEvent) => {
        if (ev.pointerId !== id) return;
        cleanup();
        if (moved) {
          swallowClick.current = true;
          // щелчок, если будет, приходит сразу после отпускания; дальше гасить нечего
          window.setTimeout(() => { swallowClick.current = false; }, 0);
        }
      };
      const cleanup = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onEnd);
        window.removeEventListener('pointercancel', onEnd);
        document.body.classList.remove('is-dragging');
        stop.current = null;
      };
      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', onEnd);
      window.addEventListener('pointercancel', onEnd);
      stop.current = cleanup;
    },
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
