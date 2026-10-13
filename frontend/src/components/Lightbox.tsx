import { useCallback, useEffect, useRef, useState, type TouchEvent as ReactTouchEvent } from 'react';
import { Icon } from './Icon';
import { api } from '../lib/api';

/**
 * Один снимок в просмотре. Либо готовый адрес (лента компании), либо номер файла —
 * тогда картинку забираем сами: файлы лежат за авторизацией, и обычный `<img src>`
 * получает 401.
 */
export interface LightboxItem {
  fileId?: string;
  url?: string;
  name: string;
  mime?: string;
}

/**
 * Просмотр вложений поверх переписки — как в мессенджерах (задача про скриншоты).
 *
 * Раньше открывалась ровно одна картинка: чтобы посмотреть второй снимок из того же
 * сообщения, приходилось закрывать окно и открывать следующий. Теперь это галерея:
 * стрелки на экране, стрелки на клавиатуре, смахивание пальцем и счётчик «2 из 5».
 * Соседние снимки подгружаются заранее — перелистывание не должно ждать сети.
 *
 * Закрытие — по фону, по Esc и по крестику: три привычных способа, и ни один из них
 * не должен требовать попасть в маленькую кнопку.
 */
export function Lightbox({ items, index = 0, onClose }: {
  items: LightboxItem[];
  index?: number;
  onClose: () => void;
}) {
  const [at, setAt] = useState(Math.min(Math.max(index, 0), Math.max(items.length - 1, 0)));
  /** Загруженные картинки: номер файла → адрес объекта. Чистим при закрытии. */
  const [blobs, setBlobs] = useState<Record<string, string>>({});
  const created = useRef<string[]>([]);
  /*
    Увеличение (13.10: «в мобилке нельзя увеличить, рассмотреть скриншот»): щипок
    двумя пальцами, двойное касание, колесо мыши. Увеличенный снимок двигают пальцем;
    смахивание листает только при обычном масштабе — иначе вместо сдвига перелистнёт.
  */
  const [zoom, setZoom] = useState({ s: 1, x: 0, y: 0 });
  const [gesture, setGesture] = useState(false);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const touch = useRef<{
    x: number; y: number; t: number; moved: boolean;
    pinch?: { d: number; s: number };
    pan?: { x: number; y: number };
  } | null>(null);
  const lastTap = useRef(0);
  const stageRef = useRef<HTMLDivElement>(null);

  const count = items.length;
  const item = items[at];
  const many = count > 1;

  const go = useCallback((step: number) => {
    if (!many) return;
    setZoom({ s: 1, x: 0, y: 0 });
    // По кругу: дойдя до последнего, следующий — первый. Так же ведут себя мессенджеры.
    setAt((i) => (i + step + count) % count);
  }, [count, many]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') go(1);
      if (e.key === 'ArrowLeft') go(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, go]);

  /*
    Забираем текущий снимок и соседей.

    Соседей — заранее и молча: человек листает быстро, и ждать сети на каждом шаге
    он не должен. Ошибку загрузки не показываем отдельно — вместо картинки останется
    имя файла и кнопка «Скачать», которой всегда можно воспользоваться.
  */
  useEffect(() => {
    let dead = false;
    const wanted = many ? [at, (at + 1) % count, (at - 1 + count) % count] : [at];
    for (const i of wanted) {
      const it = items[i];
      if (!it?.fileId || it.url) continue;
      const id = it.fileId;
      if (blobs[id]) continue;
      void api.authedBlob(`/api/files/${id}`)
        .then((blob) => {
          if (dead) return;
          const url = URL.createObjectURL(blob);
          created.current.push(url);
          setBlobs((prev) => (prev[id] ? prev : { ...prev, [id]: url }));
        })
        .catch(() => undefined);
    }
    return () => { dead = true; };
  }, [at, count, items, many, blobs]);

  // Колесо мыши — увеличить/уменьшить. Слушатель не пассивный: иначе прокрутится страница.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const z = zoomRef.current;
      const s = clampScale(z.s * (e.deltaY < 0 ? 1.2 : 1 / 1.2));
      setZoom(s === 1 ? { s: 1, x: 0, y: 0 } : { ...z, s });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const toggleZoom = () => setZoom((z) => (z.s > 1 ? { s: 1, x: 0, y: 0 } : { s: 2.5, x: 0, y: 0 }));

  const onTouchStart = (e: ReactTouchEvent) => {
    const [a, b] = [e.touches[0], e.touches[1]];
    if (!a) return;
    const z = zoomRef.current;
    if (b) {
      touch.current = { x: a.clientX, y: a.clientY, t: Date.now(), moved: true, pinch: { d: dist(a, b), s: z.s } };
    } else {
      touch.current = { x: a.clientX, y: a.clientY, t: Date.now(), moved: false, pan: { x: z.x, y: z.y } };
    }
    setGesture(true);
  };
  const onTouchMove = (e: ReactTouchEvent) => {
    const g = touch.current;
    const [a, b] = [e.touches[0], e.touches[1]];
    if (!g || !a) return;
    if (b) {
      // второй палец добавили по ходу — начинаем щипок отсюда
      if (!g.pinch) g.pinch = { d: dist(a, b), s: zoomRef.current.s };
      const s = clampScale(g.pinch.s * (dist(a, b) / g.pinch.d));
      g.moved = true;
      setZoom((z) => ({ ...z, s }));
      return;
    }
    const dx = a.clientX - g.x;
    const dy = a.clientY - g.y;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) g.moved = true;
    if (zoomRef.current.s > 1 && g.pan && !g.pinch) setZoom((z) => ({ ...z, x: g.pan!.x + dx, y: g.pan!.y + dy }));
  };
  const onTouchEnd = (e: ReactTouchEvent) => {
    const g = touch.current;
    if (e.touches.length > 0) return; // ещё держит палец — жест не кончился
    touch.current = null;
    setGesture(false);
    if (!g) return;
    if (zoomRef.current.s <= 1.02) setZoom({ s: 1, x: 0, y: 0 });
    const to = e.changedTouches[0];
    if (!g.moved) {
      // двойное касание — увеличить в 2,5 раза или вернуть как было
      const now = Date.now();
      if (now - lastTap.current < 300) { lastTap.current = 0; toggleZoom(); } else lastTap.current = now;
      return;
    }
    if (g.pinch || zoomRef.current.s > 1 || !to) return;
    const dx = to.clientX - g.x;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(to.clientY - g.y)) go(dx < 0 ? 1 : -1);
  };

  // Объекты живут ровно столько, сколько открыт просмотр: иначе они копятся в памяти.
  useEffect(() => () => { for (const u of created.current) URL.revokeObjectURL(u); }, []);

  if (!item) return null;
  const src = item.url ?? (item.fileId ? blobs[item.fileId] : undefined);
  const isVideo = (item.mime ?? '').startsWith('video/');

  return (
    <div className="lightbox-overlay" onClick={onClose}>
      <div className="lightbox-body" onClick={(e) => e.stopPropagation()}>
        <div className="lightbox-head">
          <span className="dim">
            {item.name}
            {many && <span className="lightbox-count">{at + 1} из {count}</span>}
          </span>
          <div className="lightbox-actions">
            {!isVideo && src && (
              <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={toggleZoom} title={zoom.s > 1 ? 'Как было' : 'Увеличить (или щипком, двойным касанием, колесом мыши)'}>
                {zoom.s > 1 ? 'Как было' : 'Увеличить'}
              </button>
            )}
            {src && <a className="ui-btn ui-btn-ghost ui-btn-sm" href={src} download={item.name}>Скачать</a>}
            <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={onClose} title="Закрыть"><Icon name="close" /></button>
          </div>
        </div>

        <div
          className="lightbox-stage"
          ref={stageRef}
          // Смахивание — листать; щипок и двойное касание — увеличить; при увеличении палец двигает снимок.
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onTouchCancel={() => { touch.current = null; setGesture(false); }}
        >
          {many && (
            <button className="lightbox-nav lightbox-prev" onClick={() => go(-1)} title="Предыдущее" aria-label="Предыдущее">
              <Icon name="chevron-left" size={22} />
            </button>
          )}
          {!src && <div className="dim lightbox-loading">Загружаю…</div>}
          {src && (isVideo
            ? <video className="lightbox-img" src={src} controls autoPlay />
            : (
              <img
                className="lightbox-img"
                src={src}
                alt={item.name}
                draggable={false}
                onDoubleClick={toggleZoom}
                style={{
                  transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})`,
                  transition: gesture ? 'none' : 'transform .18s ease',
                  cursor: zoom.s > 1 ? 'zoom-out' : 'zoom-in',
                }}
              />
            ))}
          {many && (
            <button className="lightbox-nav lightbox-next" onClick={() => go(1)} title="Следующее" aria-label="Следующее">
              <Icon name="chevron-right" size={22} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const clampScale = (s: number) => Math.min(5, Math.max(1, s));
const dist = (a: { clientX: number; clientY: number }, b: { clientX: number; clientY: number }) =>
  Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
