import { useCallback, useEffect, useRef, useState } from 'react';
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
  const touchX = useRef<number | null>(null);

  const count = items.length;
  const item = items[at];
  const many = count > 1;

  const go = useCallback((step: number) => {
    if (!many) return;
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

  // Объекты живут ровно столько, сколько открыт просмотр: иначе они копятся в памяти.
  useEffect(() => () => { for (const u of created.current) URL.revokeObjectURL(u); }, []);

  if (!item) return null;
  const src = item.url ?? (item.fileId ? blobs[item.fileId] : undefined);
  const isVideo = (item.mime ?? '').startsWith('video/');

  return (
    <div className="lightbox-overlay" onClick={onClose}>
      <div
        className="lightbox-body"
        onClick={(e) => e.stopPropagation()}
        // Смахивание пальцем — основной способ листать на телефоне.
        onTouchStart={(e) => { touchX.current = e.touches[0]?.clientX ?? null; }}
        onTouchEnd={(e) => {
          const from = touchX.current;
          touchX.current = null;
          const to = e.changedTouches[0]?.clientX;
          if (from == null || to == null) return;
          if (Math.abs(to - from) > 50) go(to < from ? 1 : -1);
        }}
      >
        <div className="lightbox-head">
          <span className="dim">
            {item.name}
            {many && <span className="lightbox-count">{at + 1} из {count}</span>}
          </span>
          <div className="lightbox-actions">
            {src && <a className="btn btn-ghost btn-sm" href={src} download={item.name}>Скачать</a>}
            <button className="btn btn-ghost btn-sm" onClick={onClose} title="Закрыть"><Icon name="close" /></button>
          </div>
        </div>

        <div className="lightbox-stage">
          {many && (
            <button className="lightbox-nav lightbox-prev" onClick={() => go(-1)} title="Предыдущее" aria-label="Предыдущее">
              <Icon name="chevron-left" size={22} />
            </button>
          )}
          {!src && <div className="dim lightbox-loading">Загружаю…</div>}
          {src && (isVideo
            ? <video className="lightbox-img" src={src} controls autoPlay />
            : <img className="lightbox-img" src={src} alt={item.name} />)}
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
