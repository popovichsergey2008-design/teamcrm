import './legal.css';
import { LEGAL, type LegalKind } from '../../legal';
import { PRIVACY } from '../../legal/privacy';
import { REMOTE_SUPPORT } from '../../legal/remote-support';
import type { LegalDocument } from '../../legal/types';

const DOCS: Record<LegalKind, LegalDocument> = { privacy: PRIVACY, 'remote-support': REMOTE_SUPPORT };

/**
 * Текст политики (#4675) — одна разметка для отдельной страницы и для окна поверх
 * формы. Заголовок страницы — h1, в окне название уже стоит в шапке окна (h2), поэтому
 * там документ начинается с редакции.
 */
export function LegalDoc({ kind, inDialog = false }: { kind: LegalKind; inDialog?: boolean }) {
  const doc = DOCS[kind];
  const meta = LEGAL[kind];
  const H = inDialog ? 'h3' : 'h2';
  return (
    <article className={`legal-doc${inDialog ? ' legal-doc-dialog' : ''}`}>
      {!inDialog && (
        <h1 className="legal-title">
          {doc.title}
          {doc.subtitle && <span className="legal-subtitle"> {doc.subtitle}</span>}
        </h1>
      )}
      <p className="legal-edition">Редакция от {meta.date} · версия {meta.version}</p>
      <div className="legal-lead">
        {doc.lead.map((l) => <p key={l}>{l}</p>)}
      </div>
      {doc.sections.map((s, i) => (
        <section key={s.heading} className="legal-section">
          <H className="legal-h">{i + 1}. {s.heading}</H>
          {s.text && <p className="legal-text">{s.text}</p>}
          {s.items && (
            <ul className="legal-list">
              {s.items.map((it) => (typeof it === 'string'
                ? <li key={it}>{it}</li>
                : (
                  <li key={it.text}>
                    {it.text}
                    <ol className="legal-ol">{it.ordered.map((o) => <li key={o}>{o}</li>)}</ol>
                  </li>
                )))}
            </ul>
          )}
        </section>
      ))}
    </article>
  );
}
