import { lazy, Suspense, useEffect, useRef } from 'react';
import { mdToHtml } from '../lib/rich-text';
import { markFragment } from '../lib/quote-mark';
import { hydrateImages } from './RichText';
import { linkSections } from '../lib/section-links';

/** #4902, п. 13: отрезки секретов от сервера — пароль в ленте точками, по клику виден. */
export interface SecretSpan { start: number; end: number; kind: string }
export interface SecretInfo { id: string | number; secret_spans?: SecretSpan[]; secret_of?: string }
const SecretText = lazy(() => import('./SecretText'));
const toHtml = (t: string) => mdToHtml(t, { keepBlank: true });

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
export function MessageText({ text, className, mark, sectionLinks, secrets }: {
  text: string;
  /** Сообщение чата: id и отрезки секретов — тогда значения прячутся (ленивый SecretText). */
  secrets?: SecretInfo;
  className?: string;
  /** «Настройки» → «Интеграции» в тексте — ссылками на разделы (#4737, ответы поддержки). */
  sectionLinks?: boolean;
  /** Процитированный кусок — подсветить его внутри текста, пока сообщение «найдено». */
  mark?: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const html = mdToHtml(text, { keepBlank: true });

  // картинки в сообщениях лежат за авторизацией: содержимое подставляем сами
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    return hydrateImages(root);
  }, [html]);

  useEffect(() => {
    const root = ref.current;
    if (!root || !sectionLinks) return;
    return linkSections(root);
  }, [html, sectionLinks]);

  // Подсветка цитаты живёт поверх готовой разметки и снимается, не оставляя следа.
  useEffect(() => {
    const root = ref.current;
    if (!root || !mark) return;
    return markFragment(root, mark);
  }, [html, mark]);

  const spans = secrets?.secret_spans;
  if (secrets && (spans?.length || text.includes('🔒 в Секретах'))) {
    // пока кусок грузится — тоже точками: пароль не должен мелькнуть ни на миг
    const masked = (spans ?? []).reduceRight((t, s) => t.slice(0, s.start) + '••••••' + t.slice(s.end), text);
    return (
      <Suspense fallback={<div className={`msg-rich ${className ?? ''}`}>{masked}</div>}>
        <SecretText text={text} className={className} mark={mark} info={secrets} toHtml={toHtml} markFragment={markFragment} />
      </Suspense>
    );
  }
  return <div ref={ref} className={`msg-rich ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
