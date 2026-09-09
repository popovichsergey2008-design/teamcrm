import { useEffect, useState } from 'react';

/**
 * Картинка или видео из хранилища — с токеном.
 *
 * Файлы лежат за авторизацией, и обычный `<img src="/api/files/…">` получает отказ:
 * браузер идёт за картинкой без заголовка Authorization. Поэтому тянем блоб сами и
 * показываем его. Ссылку освобождаем при размонтировании — иначе на длинной ленте
 * вложений память течёт.
 */
export function AuthedMedia({ fileId, name, mime, className, onOpen }: {
  fileId: string;
  name: string;
  mime: string;
  className?: string;
  /** Нажатие — обычно «открыть во весь экран». Без него медиа не кликается. */
  onOpen?: (p: { url: string; name: string; mime: string }) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let dead = false;
    let objectUrl = '';
    fetchBlob(fileId)
      .then((blob) => {
        if (dead) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => { if (!dead) setFailed(true); });
    return () => { dead = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [fileId]);

  if (failed) return <span className="dim">Не удалось загрузить «{name}»</span>;
  if (!url) return <span className={`media-skeleton ${className ?? ''}`} aria-hidden="true" />;

  // Видео показываем проигрывателем прямо на месте: раньше запись из чата уезжала
  // в задачу правильно, но выглядела строкой с именем файла — и человек считал,
  // что она не приложилась вовсе.
  if (mime.startsWith('video/')) {
    return <video className={`media-video ${className ?? ''}`} src={url} controls preload="metadata" />;
  }
  return (
    <button
      type="button"
      className={`media-thumb ${className ?? ''}`}
      onClick={() => onOpen?.({ url, name, mime })}
      title={onOpen ? 'Открыть во весь экран' : name}
    >
      <img src={url} alt={name} />
    </button>
  );
}

/** Скачивание с токеном живёт здесь же: два места делали одно и то же по-разному. */
export async function fetchBlob(fileId: string): Promise<Blob> {
  const { api } = await import('../lib/api');
  return api.authedBlob(`/api/files/${fileId}`);
}
