import { useEffect, useState } from 'react';
import { api } from '../lib/api';

/**
 * Аватар пользователя. Файлы лежат за авторизацией (`/api/files/:id`),
 * поэтому простой <img src> даёт 401 — тянем blob с Bearer-токеном.
 */
export function Avatar({ path, fallback, className }: { path: string | null; fallback: string; className: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let url: string | null = null;
    if (path) {
      api
        .authedObjectUrl(path)
        .then((u) => {
          url = u;
          if (active) setSrc(u);
          else URL.revokeObjectURL(u);
        })
        .catch(() => active && setSrc(null));
    } else {
      setSrc(null);
    }
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path]);

  return src ? (
    <img className={className} src={src} alt="" />
  ) : (
    <span className={`${className} avatar-ph avatar-tone-${toneOf(fallback)}`}>{fallback}</span>
  );
}

/**
 * Оттенок заглушки без фото — по буквам, один из шести (ТЗ-15).
 *
 * Одинаковые синие кружки в панели чатов сливались: глазу не за что зацепиться, кроме
 * буквы. Оттенок постоянный для одних и тех же букв, поэтому «ОТ» сегодня и завтра —
 * один и тот же цвет. Палитра та же, что у имён авторов в переписке (--who-1…6).
 */
function toneOf(text: string): number {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return (h % 6) + 1;
}
