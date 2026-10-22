import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from '../Icon';

/**
 * Подсветка места на экране с подсказкой Qevo-бота рядом (#4620): строка создания
 * задачи, новая карточка, кнопка «Новый проект».
 *
 * Своя, а не из обучения: обучение — отдельный кусок со своими правилами (счётчик,
 * «Дальше», «Больше не показывать»), а здесь подсказка живая — в ней поле ввода.
 * Места нет на экране (раздел ещё рисуется) — ждём; так и не появилось — подсказка
 * встаёт посередине, а не пропадает: в ней дело, которое надо сделать.
 */
type Rect = { top: number; left: number; width: number; height: number };
const PAD = 6;
const GAP = 12;

function find(selector: string | undefined): Element | null {
  if (!selector) return null;
  for (const el of Array.from(document.querySelectorAll(selector))) {
    const r = el.getBoundingClientRect();
    if (r.width > 2 && r.height > 2) return el;
  }
  return null;
}

export function Spot({ selector, wait, passThrough, onTargetClick, children }: {
  selector?: string;
  /** Сколько ждать место, мс. */
  wait: number;
  /** Клики проходят к подсвеченной кнопке: «нажмите сюда» — значит, нажать можно. */
  passThrough?: boolean;
  onTargetClick?: () => void;
  children: ReactNode;
}) {
  const [rect, setRect] = useState<Rect | null>(null);
  const [gone, setGone] = useState(!selector);
  const [cardH, setCardH] = useState(180);
  const card = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!selector) return undefined;
    let raf = 0;
    let scrolled = false;
    const began = performance.now();
    const tick = () => {
      const el = find(selector);
      if (!el) {
        setRect(null);
        if (performance.now() - began > wait) { setGone(true); return; }
      } else {
        setGone(false);
        if (!scrolled) { scrolled = true; el.scrollIntoView({ block: 'center', inline: 'nearest' }); }
        const r = el.getBoundingClientRect();
        setRect((p) => (p && Math.abs(p.top - r.top) < 0.5 && Math.abs(p.left - r.left) < 0.5 && Math.abs(p.width - r.width) < 0.5 && Math.abs(p.height - r.height) < 0.5
          ? p : { top: r.top, left: r.left, width: r.width, height: r.height }));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [selector, wait]);

  // нажали на подсвеченное — подсказка своё сделала
  useEffect(() => {
    if (!selector || !onTargetClick) return undefined;
    const on = (e: MouseEvent) => {
      const el = find(selector);
      if (el && e.target instanceof Node && el.contains(e.target)) onTargetClick();
    };
    document.addEventListener('click', on, true);
    return () => document.removeEventListener('click', on, true);
  }, [selector, onTargetClick]);

  useLayoutEffect(() => {
    const h = card.current?.offsetHeight;
    if (h && Math.abs(h - cardH) > 1) setCardH(h);
  }, [cardH, rect, gone, children]);

  if (!rect && !gone) return <div className="wl-spot-layer wl-spot-wait" />;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(380, vw - 32);
  const hole = rect ? { top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 } : null;
  let pos: { top: number; left: number };
  if (!hole) {
    pos = { top: Math.max(16, (vh - cardH) / 2), left: (vw - w) / 2 };
  } else {
    const clampX = (x: number) => Math.min(Math.max(16, x), vw - w - 16);
    const below = hole.top + hole.height + GAP;
    const above = hole.top - GAP - cardH;
    if (below + cardH <= vh - 16) pos = { top: below, left: clampX(hole.left + hole.width / 2 - w / 2) };
    else if (above >= 16) pos = { top: above, left: clampX(hole.left + hole.width / 2 - w / 2) };
    else pos = { top: Math.max(16, vh - cardH - 16), left: clampX(hole.left + hole.width / 2 - w / 2) };
  }

  return (
    <div className={`wl-spot-layer${passThrough ? ' wl-pass' : ''}`}>
      {hole ? <div className="wl-hole" style={hole} aria-hidden="true" /> : <div className="wl-dim" aria-hidden="true" />}
      <div ref={card} className="wl-spot" role="dialog" aria-label="Подсказка Qevo-бота" style={{ top: pos.top, left: pos.left, width: w }}>
        <div className="wl-spot-who"><span className="wl-bot-mark" aria-hidden="true"><Icon name="robot" size={14} /></span> Qevo-бот</div>
        {children}
      </div>
    </div>
  );
}
