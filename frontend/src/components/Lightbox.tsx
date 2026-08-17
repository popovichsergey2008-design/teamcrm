import { useEffect } from 'react';
import { Icon } from './Icon';

/** Попап-просмотр картинки/видео поверх карточки (закрытие по фону/Esc). */
export function Lightbox({ url, name, mime, onClose }: { url: string; name: string; mime?: string; onClose: () => void }) {
  const isVideo = (mime ?? '').startsWith('video/');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="lightbox-overlay" onClick={onClose}>
      <div className="lightbox-body" onClick={(e) => e.stopPropagation()}>
        <div className="lightbox-head">
          <span className="dim">{name}</span>
          <div className="lightbox-actions">
            <a className="btn btn-ghost btn-sm" href={url} download={name}>Скачать</a>
            <button className="btn btn-ghost btn-sm" onClick={onClose} title="Закрыть"><Icon name="close" /></button>
          </div>
        </div>
        {isVideo
          ? <video className="lightbox-img" src={url} controls autoPlay />
          : <img className="lightbox-img" src={url} alt={name} />}
      </div>
    </div>
  );
}
