import { useEffect, useRef } from 'react';
import { mdToHtml } from '../lib/rich-text';
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
export function MessageText({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = mdToHtml(text);

  // картинки в сообщениях лежат за авторизацией: содержимое подставляем сами
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    return hydrateImages(root);
  }, [html]);

  return <div ref={ref} className={`msg-rich ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
