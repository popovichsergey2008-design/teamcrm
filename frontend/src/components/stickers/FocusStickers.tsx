import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { navigate } from '../../lib/router';
import { openQuickSticker, stickersApi, stickersChanged, STICKERS_CHANGED, type Sticker } from '../../lib/stickers-api';
import './stickers.css';

/**
 * «📌 Стикеры на сегодня» в Фокусе дня (#4997, шаг 8.1): цветные мини-стикеры с галочками и «＋»;
 * есть просроченные — «и 2 со вчера → на сегодня?». Стикеров нет — блока нет (только «＋»).
 */
export function FocusStickers() {
  const [items, setItems] = useState<Sticker[] | null>(null);
  const [overdue, setOverdue] = useState<Sticker[]>([]);
  const load = useCallback(() => stickersApi.day().then((r) => { setItems(r.items); setOverdue(r.overdue); }).catch(() => setItems([])), []);
  useEffect(() => {
    void load();
    const on = () => void load();
    window.addEventListener(STICKERS_CHANGED, on);
    return () => window.removeEventListener(STICKERS_CHANGED, on);
  }, [load]);
  if (!items) return null;
  const done = (s: Sticker) => void stickersApi.mark([s.id], 'done').then(stickersChanged);
  return (
    <section className="fst" aria-label="Стикеры на сегодня">
      <div className="fst-head">
        <button className="fst-title" onClick={() => navigate({ section: 'stickers' })}>📌 Стикеры на сегодня · {items.length}</button>
        <button className="fst-add" onClick={() => openQuickSticker()} aria-label="Новый стикер" title="Новый стикер (Alt+N)"><Icon name="plus" size={14} /></button>
      </div>
      {items.length > 0 && (
        <div className="fst-list">
          {items.map((s) => (
            <div key={s.id} className={`fst-note st-${s.color}`}>
              <button className="fst-check" onClick={() => done(s)} aria-label={`Готово: ${s.text}`} title="Готово"><Icon name="check" size={12} /></button>
              <span>{s.time ? <b>{s.time} </b> : null}{s.text}</span>
            </div>
          ))}
        </div>
      )}
      {overdue.length > 0 && (
        <button className="fst-over" onClick={() => void stickersApi.overdueToToday().then(stickersChanged)}>
          и {overdue.length} со вчера → на сегодня?
        </button>
      )}
    </section>
  );
}
