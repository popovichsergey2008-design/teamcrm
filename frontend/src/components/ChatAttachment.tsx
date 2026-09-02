import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { api } from '../lib/api';
import { isImageName } from '../lib/attachments';

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
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const mime = useRef<string>('');

  useEffect(() => {
    if (!isImage) return;
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
  }, [fileId, isImage]);

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

  if (isImage && url) {
    return (
      <button className="chat-img" onClick={() => onOpen(url, fileName, mime.current)} title={fileName}>
        <img src={url} alt={fileName} />
      </button>
    );
  }
  // пока грузится — место под картинку занято, иначе лента прыгает при появлении
  if (isImage && !failed) return <span className="chat-img chat-img-wait" aria-hidden="true" />;

  return (
    <button className="chat-file" onClick={download} title="Скачать">
      <Icon name="paperclip" size={14} /> {fileName}
    </button>
  );
}
