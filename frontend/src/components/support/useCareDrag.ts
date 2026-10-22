import { useCallback, useEffect, useRef, useState } from 'react';
import { clampOffset, isDrag, keyNudge, Offset, parseOffset, ZERO, type Box, type Insets } from '../../lib/care-drag';

/** Вернуть островок, кружок и окно на место разом — кнопкой в шапке окна. */
export const CARE_POS_RESET = 'qevo:care-pos-reset';
export const resetCarePositions = () => window.dispatchEvent(new Event(CARE_POS_RESET));

const NARROW = '(max-width: 720px)';
const narrowNow = () => window.matchMedia?.(NARROW).matches ?? false;

let probe: HTMLDivElement | null = null;
/** safe-area сверху и снизу — числом: CSS отдаёт их только через env() и переменные. */
function safeArea(): { top: number; bottom: number } {
  if (!probe) {
    probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:fixed;left:0;top:0;width:0;visibility:hidden;pointer-events:none;height:var(--safe-top,0px);padding-bottom:var(--safe-bottom,0px)';
    document.body.appendChild(probe);
  }
  const cs = getComputedStyle(probe);
  return { top: parseFloat(cs.height) || 0, bottom: parseFloat(cs.paddingBottom) || 0 };
}

/** Поля видимой области: часы и вырез сверху, нижние вкладки и полоса жестов снизу. */
function insets(m: number): Insets {
  const s = safeArea();
  const nav = document.querySelector<HTMLElement>('.bottom-nav');
  const navH = nav && getComputedStyle(nav).display !== 'none' ? Math.max(0, window.innerHeight - nav.getBoundingClientRect().top) : 0;
  return { top: s.top + m, right: m, bottom: Math.max(navH, s.bottom) + m, left: m };
}

const view = () => ({ w: document.documentElement.clientWidth || window.innerWidth, h: window.innerHeight });

function read(key: string): Offset {
  try { return parseOffset(localStorage.getItem(key)); } catch { return ZERO; }
}
function write(key: string, o: Offset): void {
  try {
    if (o.dx || o.dy) localStorage.setItem(key, JSON.stringify(o));
    else localStorage.removeItem(key);
  } catch { /* приватное окно — позиция просто не запомнится */ }
}

interface Opts {
  /** Только на этой ширине (окно на телефоне — шторка, его не таскают). */
  media?: string;
  /** Нажатия по этим элементам — не перетаскивание (кнопки в шапке окна). */
  ignore?: string;
  /** Поле до краёв экрана, px. */
  margin?: number;
  /**
    Тап пальцем без сдвига. На телефоне после перетаскивания Chrome не всегда
    присылает следующий click — тап ловим сами по pointerup, а click за ним гасим.
  */
  onTap?: () => void;
}

/**
 * Перетаскивание мышью и пальцем (#4636): pointer events + CSS `translate` — сдвиг
 * не трогает `transform` (островок на телефоне центрируется им) и не перерисовывает
 * React на каждом движении. Клик без сдвига (< 5 px) остаётся кликом. Позиция —
 * в localStorage, своя для телефона и ПК; при смене размера окна и повороте элемент
 * прижимается в видимую область, а запомненное желание не теряется.
 */
export function useCareDrag<T extends HTMLElement>(key: string, { media, ignore, margin = 4, onTap }: Opts = {}) {
  const el = useRef<T | null>(null);
  const storeKey = useRef('');
  /** Где человек хочет видеть элемент (запомнено) и где он стоит сейчас (после прижатия). */
  const want = useRef<Offset>(ZERO);
  const cur = useRef<Offset>(ZERO);
  const on = useRef(true);
  const [moved, setMoved] = useState(false);
  const drag = useRef<{ id: number; sx: number; sy: number; o: Offset; box: Box; moved: boolean } | null>(null);
  const suppress = useRef(false);
  const tapRef = useRef(onTap);
  tapRef.current = onTap;
  /** Погасить ближайший click (после перетаскивания или своего тапа) — ненадолго. */
  const swallowClick = () => {
    suppress.current = true;
    window.setTimeout(() => { suppress.current = false; }, 700);
  };
  const frame = useRef(0);

  const paint = useCallback((o: Offset) => {
    cur.current = o;
    const n = el.current;
    if (n) n.style.translate = o.dx || o.dy ? `${o.dx}px ${o.dy}px` : '';
  }, []);

  /** Где элемент стоял бы без сдвига. Скрыт (display: none) — null. */
  const natural = useCallback((): Box | null => {
    const n = el.current;
    if (!n) return null;
    const b = n.getBoundingClientRect();
    if (!b.width && !b.height) return null;
    return { x: b.left - cur.current.dx, y: b.top - cur.current.dy, w: b.width, h: b.height };
  }, []);

  /** Прижать желаемое место в видимую область. */
  const fit = useCallback(() => {
    if (drag.current?.moved) return;
    if (!on.current) { paint(ZERO); return; }
    const box = natural();
    if (!box) return;
    paint(clampOffset(want.current, box, view(), insets(margin)));
  }, [margin, natural, paint]);

  const load = useCallback(() => {
    on.current = !media || (window.matchMedia?.(media).matches ?? true);
    storeKey.current = `${key}${narrowNow() ? ':m' : ''}`;
    want.current = read(storeKey.current);
    setMoved(!!(want.current.dx || want.current.dy));
    fit();
  }, [fit, key, media]);

  const commit = useCallback((o: Offset) => {
    want.current = o;
    write(storeKey.current, o);
    setMoved(!!(o.dx || o.dy));
  }, []);

  const reset = useCallback(() => { commit(ZERO); paint(ZERO); fit(); }, [commit, fit, paint]);

  // элемент появляется и пропадает (островок ↔ окно ↔ кружок) — ставим на место сразу
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const ro = useRef<ResizeObserver | null>(null);
  const ref = useCallback((n: T | null) => {
    ro.current?.disconnect();
    el.current = n;
    if (!n) return;
    load();
    // размер самого элемента меняется (время ответа, окно во весь экран) — тоже прижать
    if (typeof ResizeObserver !== 'undefined') {
      ro.current ??= new ResizeObserver(() => fitRef.current());
      ro.current.observe(n);
    }
  }, [load]);

  useEffect(() => {
    const onResize = () => fit();
    const mq = [window.matchMedia?.(NARROW), media ? window.matchMedia?.(media) : null].filter(Boolean) as MediaQueryList[];
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    for (const q of mq) q.addEventListener?.('change', load);
    window.addEventListener(CARE_POS_RESET, reset);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
      for (const q of mq) q.removeEventListener?.('change', load);
      window.removeEventListener(CARE_POS_RESET, reset);
      cancelAnimationFrame(frame.current);
      ro.current?.disconnect();
    };
  }, [fit, load, media, reset]);

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    suppress.current = false;
    if (!on.current || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (ignore && (e.target as Element).closest?.(ignore)) return;
    const box = natural();
    if (!box) return;
    drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, o: cur.current, box, moved: false };
    // мышь сразу уходит за край островка — движения ловим и там (клик с захватом остаётся кликом)
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (!d.moved) {
      if (!isDrag(dx, dy)) return;
      d.moved = true;
      el.current?.classList.add('care-dragging');
    }
    e.preventDefault();
    const next = clampOffset({ dx: d.o.dx + dx, dy: d.o.dy + dy }, d.box, view(), insets(margin));
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => paint(next));
  };
  const end = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!d.moved) {
      if (e.type === 'pointerup' && e.pointerType !== 'mouse' && tapRef.current) { swallowClick(); tapRef.current(); }
      return;
    }
    cancelAnimationFrame(frame.current);
    const next = clampOffset({ dx: d.o.dx + e.clientX - d.sx, dy: d.o.dy + e.clientY - d.sy }, d.box, view(), insets(margin));
    paint(next);
    commit(next);
    el.current?.classList.remove('care-dragging');
    // отпустили после перетаскивания — следующий click не «открыть»
    if (e.type === 'pointerup') swallowClick();
  };
  const onClickCapture = (e: React.MouseEvent<HTMLElement>) => {
    if (!suppress.current) return;
    suppress.current = false;
    e.preventDefault();
    e.stopPropagation();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!on.current || e.altKey || e.ctrlKey || e.metaKey) return;
    const k = keyNudge(e.key, e.shiftKey);
    if (!k) return;
    e.preventDefault();
    e.stopPropagation();
    if (k === 'reset') { reset(); return; }
    const box = natural();
    if (!box) return;
    const next = clampOffset({ dx: cur.current.dx + k.dx, dy: cur.current.dy + k.dy }, box, view(), insets(margin));
    paint(next);
    commit(next);
  };
  const onDoubleClick = (e: React.MouseEvent<HTMLElement>) => {
    if (ignore && (e.target as Element).closest?.(ignore)) return;
    reset();
  };

  return {
    ref,
    moved,
    reset,
    onKeyDown,
    handlers: { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end, onClickCapture },
    onDoubleClick,
  };
}
