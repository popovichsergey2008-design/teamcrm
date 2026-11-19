import { useEffect, useState } from 'react';
import { navigate } from '../../lib/router';
import { stickersApi, STICKERS_CHANGED, ymd, type Sticker } from '../../lib/stickers-api';
import './stickers.css';

/*
  Стикеры в Календаре (#4997, шаг 8.2): в шапке дня — цветные точки, при наведении — текст.
  Стикер не встреча: слот не занимает, свободное время из-за него не меняется. Доску читаем
  один раз на календарь — точки во всех днях из одного запроса.
*/
let cache: Promise<Sticker[]> | null = null;
const listeners = new Set<() => void>();
function stickers(): Promise<Sticker[]> {
  if (!cache) cache = stickersApi.board().then((b) => b.items).catch(() => []);
  return cache;
}
if (typeof window !== 'undefined') {
  window.addEventListener(STICKERS_CHANGED, () => { cache = null; listeners.forEach((f) => f()); });
}

export function useDayStickers(): Map<string, Sticker[]> {
  const [map, setMap] = useState<Map<string, Sticker[]>>(new Map());
  useEffect(() => {
    let alive = true;
    const load = () => void stickers().then((list) => {
      if (!alive) return;
      const m = new Map<string, Sticker[]>();
      for (const s of list) if (s.date) m.set(s.date, [...(m.get(s.date) ?? []), s]);
      setMap(m);
    });
    load();
    listeners.add(load);
    return () => { alive = false; listeners.delete(load); };
  }, []);
  return map;
}

export function StickerDots({ day, map }: { day: Date; map: Map<string, Sticker[]> }) {
  const list = map.get(ymd(day)) ?? [];
  if (!list.length) return null;
  const title = list.map((s) => `${s.time ? `${s.time} ` : ''}${s.text}`).join('\n');
  return (
    <button type="button" className="std-dots" title={`Стикеры:\n${title}`} aria-label={`Стикеры на день: ${list.length}`}
      onClick={(e) => { e.stopPropagation(); navigate({ section: 'stickers' }); }}>
      {list.slice(0, 5).map((s) => <i key={s.id} className={`st-${s.color}`} />)}
      {list.length > 5 && <span>+{list.length - 5}</span>}
    </button>
  );
}
