import { hrefOf, splitMessage } from '../lib/chat-text';

/**
 * Текст сообщения: ссылки кликаются, упоминания выделены.
 *
 * Одним местом на все переписки — чат компании, чат задачи, ветки. Раньше разбор
 * стоял только в карточке задачи, и в обычном чате вставленный адрес оставался
 * серым текстом: его выделяли и копировали руками.
 */
export function MessageText({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className}>
      {splitMessage(text).map((p, i) => (
        p.kind === 'mention' ? <span key={i} className="msg-mention">{p.value}</span>
          : p.kind === 'link'
            ? <a key={i} href={hrefOf(p.value)} target="_blank" rel="noreferrer">{p.value}</a>
            : <span key={i}>{p.value}</span>
      ))}
    </div>
  );
}
