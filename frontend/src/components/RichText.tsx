import { useEffect, useRef } from 'react';
import { mdToHtml } from '../lib/rich-text';
import { fetchBlob } from './AuthedMedia';

/**
 * Подставить содержимое картинкам `img[data-file-id]`.
 *
 * Файлы за авторизацией: голый `src="/api/files/12"` получил бы 401, поэтому блоб
 * тянем сами. Одна функция на показ и на редактор — картинка обязана выглядеть
 * одинаково там и там. Возвращает уборку: ссылки на блобы освобождаются, иначе на
 * карточке с десятком снимков память течёт при каждом открытии.
 */
export function hydrateImages(
  root: HTMLElement,
  onOpen?: (p: { url: string; name: string; mime: string }) => void,
): () => void {
  const urls: string[] = [];
  let dead = false;
  root.querySelectorAll<HTMLImageElement>('img[data-file-id]:not([src])').forEach((img) => {
    const id = img.dataset.fileId;
    if (!id) return;
    fetchBlob(id).then((blob) => {
      if (dead) return;
      const url = URL.createObjectURL(blob);
      urls.push(url);
      img.src = url;
      if (onOpen) {
        img.style.cursor = 'zoom-in';
        img.onclick = () => onOpen({ url, name: img.alt || 'снимок', mime: blob.type || 'image/*' });
      }
    }).catch(() => { img.alt = `Не удалось загрузить «${img.alt}»`; });
  });
  return () => { dead = true; urls.forEach((u) => URL.revokeObjectURL(u)); };
}

/**
 * Форматированный текст в режиме чтения: заголовки, списки, жирный, ссылки, картинки.
 *
 * HTML собирается нашим же разбором из разметки (lib/rich-text) — в нём нет ничего,
 * чего мы не написали сами: текст экранирован, ссылки только веб-схем, картинки
 * только по номеру файла. Поэтому вставка готового HTML здесь безопасна.
 */
export function RichText({ text, className, onOpenImage }: {
  text: string;
  className?: string;
  /** Нажатие на картинку — обычно «открыть во весь экран». */
  onOpenImage?: (p: { url: string; name: string; mime: string }) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const html = mdToHtml(text);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    return hydrateImages(root, onOpenImage);
  }, [html, onOpenImage]);

  return <div ref={ref} className={`rich-text ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
