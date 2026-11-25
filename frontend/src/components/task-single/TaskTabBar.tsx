import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '../Icon';

export type TabState = 'has' | 'normal' | 'empty';
export interface TabItem<K extends string> { key: K; label: string; icon: IconName; count?: ReactNode; state: TabState }

/**
 * Полоса табов карточки задачи (#5016, ТЗ п. 6 c–f).
 *
 * Есть содержимое — тёмный текст и счётчик, пусто — серым без счётчика, открытый —
 * синим с полосой снизу. Не помещаются по ширине — последние уходят в «Ещё ▾»;
 * на телефоне полоса просто листается пальцем (CSS).
 */
export function TaskTabBar<K extends string>({ items, value, onChange }: { items: TabItem<K>[]; value: K; onChange: (k: K) => void }) {
  const bar = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(items.length);
  const [more, setMore] = useState(false);

  useLayoutEffect(() => {
    const el = bar.current;
    const m = measure.current;
    if (!el || !m) return;
    const calc = () => {
      if (window.matchMedia('(max-width: 600px)').matches) { setFit(items.length); return; }
      const widths = Array.from(m.children).map((c) => (c as HTMLElement).offsetWidth + 2);
      const room = el.clientWidth - 24;
      const total = widths.reduce((a, b) => a + b, 0);
      if (total <= room) { setFit(items.length); return; }
      const moreW = 86;
      let used = 0; let n = 0;
      for (const w of widths) { if (used + w + moreW > room) break; used += w; n++; }
      setFit(Math.max(1, n));
    };
    calc();
    const ro = new ResizeObserver(calc);
    ro.observe(el);
    return () => ro.disconnect();
  }, [items.length, items.map((i) => `${i.label}${i.state}${String(i.count ?? '')}`).join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    if (!more) return;
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.ts-tabs-more')) setMore(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [more]);

  // открытый таб всегда на виду: если он ушёл в «Ещё», ставим его последним видимым
  let shown = items.slice(0, fit);
  let hidden = items.slice(fit);
  const activeHidden = hidden.find((i) => i.key === value);
  if (activeHidden && shown.length) {
    const last = shown[shown.length - 1];
    shown = [...shown.slice(0, -1), activeHidden];
    hidden = [last, ...hidden.filter((i) => i.key !== value)];
  }

  const tab = (i: TabItem<K>, inMenu = false) => (
    <button key={i.key} type="button" role="tab" aria-selected={i.key === value}
      className={`${inMenu ? 'ts-tabs-item' : 'ts-tab'} is-${i.state}${i.key === value ? ' is-on' : ''}`}
      onClick={() => { onChange(i.key); setMore(false); }}>
      <Icon name={i.icon} size={14} /> {i.label}
      {i.count != null && i.state === 'has' && <span className="ts-tab-n">{i.count}</span>}
    </button>
  );

  return (
    <div className="ts-tabs-wrap">
      <div className="ts-tabs" ref={bar} role="tablist" aria-label="Разделы задачи">
        {shown.map((i) => tab(i))}
        {hidden.length > 0 && (
          <span className="ts-tabs-more">
            <button type="button" className="ts-tab is-normal" aria-haspopup="menu" aria-expanded={more} onClick={() => setMore((v) => !v)}>
              Ещё <Icon name="chevron-down" size={13} />
            </button>
            {more && <div className="ts-tabs-menu" role="menu">{hidden.map((i) => tab(i, true))}</div>}
          </span>
        )}
      </div>
      {/* невидимая копия всех табов — по ней меряем, сколько помещается */}
      <div className="ts-tabs ts-tabs-measure" ref={measure} aria-hidden="true">
        {items.map((i) => (
          <span key={i.key} className={`ts-tab is-${i.state}`}><Icon name={i.icon} size={14} /> {i.label}{i.count != null && i.state === 'has' && <span className="ts-tab-n">{i.count}</span>}</span>
        ))}
      </div>
    </div>
  );
}
