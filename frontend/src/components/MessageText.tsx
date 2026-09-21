import { useEffect, useRef } from 'react';
import { mdToHtml } from '../lib/rich-text';
import { markFragment } from '../lib/quote-mark';
import { hydrateImages } from './RichText';

/**
 * Текст сообщения: ссылки кликаются, упоминания выделены, разметка видна.
 *
 * Одним местом на все переписки — чат компании, чат задачи, ветки. Раньше здесь был
 * разбор только ссылок и упоминаний, а всё остальное показывалось как есть: текст,
 * вставленный из Word или с сайта, приходил стеной слов — без списков, заголовков и
 * абзацев. Теперь сообщение проходит тем же разбором, что и описание задачи, и
 * выглядит так, как его писали.
 *
 * Хранится по-прежнему ТЕКСТ с лёгкой разметкой: сообщения уходят в письма, в
 * Telegram, в поиск и к ИИ — там HTML был бы мусором.
 */
export function MessageText({ text, className, mark }: {
  text: string;
  className?: string;
  /** Процитированный кусок — подсветить его внутри текста, пока сообщение «найдено». */
  mark?: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const html = mdToHtml(text);

  // картинки в сообщениях лежат за авторизацией: содержимое подставляем сами
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    return hydrateImages(root);
  }, [html]);

  // Подсветка цитаты живёт поверх готовой разметки и снимается, не оставляя следа.
  useEffect(() => {
    const root = ref.current;
    if (!root || !mark) return;
    return markFragment(root, mark);
  }, [html, mark]);

  return <div ref={ref} className={`msg-rich ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
