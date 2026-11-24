import { useRef, useState } from 'react';
import type React from 'react';

/**
 * #5030: микрофон везде одинаково — как в Telegram.
 *
 * Нажал и держишь — идёт запись; отпустил — запись остановилась (дальше как в этом месте:
 * текст в поле, голосовое уходит, вопрос задаётся); смахнул вверх — отменилась. Короткое
 * нажатие ничего не пишет — подсказывает «удерживайте». С клавиатуры (Enter/пробел) —
 * переключатель: нажать, чтобы начать, ещё раз — чтобы закончить.
 *
 * Раньше в одних местах надо было держать, в других — нажать, говорить и нажать снова.
 *
 * Вернуть: `bind` — разложить на кнопку микрофона (вместо её onClick), `holding`/`cancelling` —
 * для подписи «отпустите — отправлю / отпустите — отменю».
 */
export function useHoldToTalk(o: {
  start: () => unknown;
  stop: () => void;
  /** Отмена без результата; нет — смахивание просто останавливает. */
  cancel?: () => void;
  recording: boolean;
  disabled?: boolean;
}) {
  const [holding, setHolding] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const on = useRef(false);
  const cancelRef = useRef(false);
  const timer = useRef(0);
  const y0 = useRef(0);
  const opts = useRef(o);
  opts.current = o;

  const finish = (cancel: boolean) => {
    on.current = false;
    setHolding(false);
    setCancelling(false);
    if (cancel && opts.current.cancel) opts.current.cancel(); else opts.current.stop();
  };

  const bind = {
    style: { touchAction: 'none' as const, userSelect: 'none' as const, WebkitUserSelect: 'none' as const, WebkitTouchCallout: 'none' as const },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    onPointerDown: (e: React.PointerEvent) => {
      if (opts.current.disabled || e.button > 0) return;
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      y0.current = e.clientY;
      cancelRef.current = false;
      if (opts.current.recording) return; // запись идёт (начата с клавиатуры) — закончим на отпускании
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        on.current = true;
        setHolding(true);
        try { navigator.vibrate?.(15); } catch { /* без вибрации */ }
        // отпустили, пока браузер спрашивал доступ к микрофону, — сразу останавливаем
        void Promise.resolve(opts.current.start()).then(() => { if (!on.current && !cancelRef.current) opts.current.stop(); });
      }, 200);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!on.current) return;
      const up = y0.current - e.clientY > 60;
      cancelRef.current = up;
      setCancelling(up);
    },
    onPointerUp: (e: React.PointerEvent) => {
      window.clearTimeout(timer.current);
      if (on.current) { finish(cancelRef.current); return; }
      if (opts.current.recording) { opts.current.stop(); return; }
      if (!opts.current.disabled) holdTip(e.currentTarget as HTMLElement);
    },
    onPointerCancel: () => {
      window.clearTimeout(timer.current);
      if (on.current) { cancelRef.current = true; finish(true); }
    },
    onClick: (e: React.MouseEvent) => {
      // клик мышью/пальцем уже разобран pointer-событиями; detail === 0 — клавиатура
      if (e.detail !== 0 || opts.current.disabled) return;
      if (opts.current.recording) opts.current.stop(); else void opts.current.start();
    },
  };
  return { holding, cancelling, bind };
}

/** Короткое нажатие: подсказка над кнопкой, как в Telegram. Без React — живёт 1,8 с и исчезает. */
function holdTip(el: HTMLElement) {
  if (document.querySelector('[data-hold-tip]')) return;
  const r = el.getBoundingClientRect();
  const tip = document.createElement('div');
  tip.setAttribute('data-hold-tip', '');
  tip.setAttribute('role', 'status');
  tip.textContent = 'Удерживайте, чтобы записать';
  Object.assign(tip.style, {
    position: 'fixed', zIndex: '9999', left: `${Math.max(8, Math.min(window.innerWidth - 228, r.left + r.width / 2 - 110))}px`,
    top: `${Math.max(8, r.top - 44)}px`, width: '220px', textAlign: 'center', padding: '8px 10px', borderRadius: '10px',
    background: 'var(--text, #222)', color: 'var(--bg, #fff)', fontSize: '13px', pointerEvents: 'none', boxShadow: '0 6px 18px rgba(0,0,0,.2)',
  });
  document.body.appendChild(tip);
  window.setTimeout(() => tip.remove(), 1800);
}
