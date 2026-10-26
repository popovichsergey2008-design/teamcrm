import './legal.css';
import type { ReactNode } from 'react';
import { LEGAL, type LegalKind } from '../../legal';
import { PRIVACY } from '../../legal/privacy';
import { REMOTE_SUPPORT } from '../../legal/remote-support';
import type { LegalBlock, LegalDocument } from '../../legal/types';

const DOCS: Record<LegalKind, LegalDocument> = { privacy: PRIVACY, 'remote-support': REMOTE_SUPPORT };

/** `**жирное**` и `[[kind|текст]]` — ссылка на другой наш документ; остальное — как есть. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|\[\[(?:privacy|remote-support)\|[^\]]+\]\])/).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) return <b key={i}>{part.slice(2, -2)}</b>;
    const link = part.match(/^\[\[(privacy|remote-support)\|([^\]]+)\]\]$/);
    if (link) return <a key={i} href={LEGAL[link[1] as LegalKind].path} target="_blank" rel="noopener">{link[2]}</a>;
    return part;
  });
}

function Block({ b, inDialog }: { b: LegalBlock; inDialog: boolean }) {
  if ('h' in b) {
    const H = inDialog ? 'h3' : 'h2';
    return <H className="legal-h">{inline(b.h)}</H>;
  }
  if ('p' in b) return <p className="legal-p">{inline(b.p)}</p>;
  if ('ul' in b) return <ul className="legal-list">{b.ul.map((t, i) => <li key={i}>{inline(t)}</li>)}</ul>;
  if ('ol' in b) return <ol className="legal-list">{b.ol.map((t, i) => <li key={i}>{inline(t)}</li>)}</ol>;
  return (
    // на телефоне строки таблицы — карточками (подпись столбца над ячейкой), см. legal.css
    <div className="legal-table-wrap" tabIndex={0} role="region" aria-label="Таблица">
      <table className="legal-table">
        <thead><tr>{b.table.head.map((c, i) => <th key={i} scope="col">{inline(c)}</th>)}</tr></thead>
        <tbody>
          {b.table.rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => (j === 0
              ? <th key={j} scope="row">{inline(c)}</th>
              : <td key={j} data-label={b.table.head[j]}>{inline(c)}</td>))}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Текст политики (#4675) — одна разметка для отдельной страницы и для окна поверх
 * формы. На странице название — h1; в окне оно уже стоит в шапке окна, поэтому там
 * документ начинается с редакции.
 */
export function LegalDoc({ kind, inDialog = false }: { kind: LegalKind; inDialog?: boolean }) {
  const doc = DOCS[kind];
  return (
    <article className={`legal-doc${inDialog ? ' legal-doc-dialog' : ''}`}>
      {!inDialog && <h1 className="legal-title">{doc.title}</h1>}
      <p className="legal-edition">{doc.edition}</p>
      {doc.blocks.map((b, i) => <Block key={i} b={b} inDialog={inDialog} />)}
    </article>
  );
}
