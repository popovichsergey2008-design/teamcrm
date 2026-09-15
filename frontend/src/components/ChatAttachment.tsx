import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { api } from '../lib/api';
import { isImageName, isPlayableName } from '../lib/attachments';

/**
 * Вложение в сообщении.
 *
 * Картинка показывается прямо в переписке, остальное — строкой со скрепкой.
 * Иначе присланный скриншот выглядит как «image.png» и его надо открывать, чтобы
 * понять, о чём речь, — а обсуждают обычно именно то, что на картинке.
 *
 * Файлы лежат за авторизацией, поэтому обычный <img src="/api/files/…"> отдаёт 401:
 * тянем блоб с токеном и показываем его. Ссылку освобождаем при размонтировании —
 * в длинной переписке иначе течёт память.
 */
export function ChatAttachment({ fileId, fileName, onOpen }: {
  fileId: string;
  fileName: string;
  /** Клик по картинке — показать её целиком; блоб уже загружен, второй раз не тянем. */
  onOpen: (url: string, name: string, mime: string) => void;
}) {
  const isImage = isImageName(fileName);
  /*
    Голосовое и запись экрана проигрываются прямо в ленте.

    Ссылка «скачать запись» превращает клип в документ: его надо сохранить, найти в
    загрузках и открыть плеером — ради двадцати секунд объяснения этого никто не делает,
    и клипы перестают отправлять вовсе.
  */
  const media = isPlayableName(fileName);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const mime = useRef<string>('');
  /*
    Грузим, только когда вложение подошло к экрану.

    В задаче с сотней сообщений и десятком скриншотов прежний подход тянул все файлы
    разом при открытии: секунды ожидания и мегабайты трафика ради картинок, до
    которых человек, скорее всего, не долистает. Запас в 400 точек — чтобы к моменту
    появления в поле зрения картинка уже была на месте, а не подгружалась на глазах.
  */
  const holder = useRef<HTMLElement | null>(null);
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    if (near || (!isImage && !media)) return;
    const el = holder.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setNear(true); io.disconnect(); }
    }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [near, isImage, media]);

  useEffect(() => {
    if (!near) return;
    if (!isImage && !media) return;
    let dead = false;
    let objectUrl = '';
    api.authedBlob(`/api/files/${fileId}`)
      .then((blob) => {
        if (dead) return;
        mime.current = blob.type;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => { if (!dead) setFailed(true); });
    return () => { dead = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [fileId, isImage, media, near]);

  /** Не картинка (или картинка не загрузилась) — скачиваем по нажатию, тоже с токеном. */
  const download = async () => {
    try {
      const blob = await api.authedBlob(`/api/files/${fileId}`);
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(href), 5000);
    } catch { setFailed(true); }
  };

  if (media && url) {
    return media === 'video'
      ? <video className="chat-clip" src={url} controls preload="metadata" />
      : <audio className="chat-clip-audio" src={url} controls preload="metadata" />;
  }
  if ((isImage || media) && !url && !failed) {
    // Место под вложение занято, пока оно грузится: иначе лента прыгает под курсором.
    // Этот же узел наблюдает пересечение с экраном — по нему и решаем, пора ли грузить.
    return <span ref={holder} className="chat-img chat-img-wait" aria-hidden="true" />;
  }

  if (isImage && url) {
    return (
      <button className="chat-img" onClick={() => onOpen(url, fileName, mime.current)} title={fileName}>
        <img src={url} alt={fileName} />
      </button>
    );
  }
  // пока грузится — место под картинку занято, иначе лента прыгает при появлении
  if (isImage && !failed) return <span ref={holder} className="chat-img chat-img-wait" aria-hidden="true" />;

  return (
    <button className="chat-file" onClick={download} title="Скачать">
      <Icon name="paperclip" size={14} /> {fileName}
    </button>
  );
}
