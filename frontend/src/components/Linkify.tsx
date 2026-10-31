import { Fragment } from 'react';
import { hrefOf, splitMessage } from '../lib/chat-text';

/**
 * Простой текст, в котором адреса кликаются (#4702) — для заметок, описаний и
 * повесток, где разметки нет, а ссылку раньше приходилось копировать в адресную строку.
 * Разбор — тот же, что в переписке (`splitMessage`): хвостовая точка не уезжает в адрес.
 * Клик по ссылке не всплывает — строка-кнопка вокруг не открывается вместо сайта.
 */
export function Linkify({ text }: { text: string | null | undefined }) {
  if (!text) return null;
  return (
    <>
      {splitMessage(text).map((p, i) => (p.kind === 'link'
        ? <a key={i} href={hrefOf(p.value)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{p.value}</a>
        : <Fragment key={i}>{p.value}</Fragment>))}
    </>
  );
}
