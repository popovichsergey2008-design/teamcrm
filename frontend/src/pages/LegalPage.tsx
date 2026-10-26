import { useEffect } from 'react';
import { Logo } from '../components/Logo';
import { LegalDoc } from '../components/legal/LegalDoc';
import { LEGAL, type LegalKind } from '../legal';

/**
 * Публичная страница политики (#4675): `/legal/privacy` и `/legal/remote-support`.
 *
 * Открывается до входа и после — App показывает её раньше экрана входа, как `/get`.
 * Два документа — два адреса: заказчик просил разные страницы для регистрации и для
 * удалённой поддержки.
 */
export function LegalPage({ kind }: { kind: LegalKind }) {
  const meta = LEGAL[kind];
  useEffect(() => {
    const prev = document.title;
    document.title = `${meta.title} · QEVO`;
    return () => { document.title = prev; };
  }, [meta.title]);

  return (
    <div className="legal-page">
      <div className="legal-wrap">
        <header className="legal-top">
          <a className="legal-brand" href="/" aria-label="QEVO — на главную">
            <Logo size={28} />
            <span>QEVO</span>
          </a>
          <nav className="legal-nav" aria-label="Документы">
            {(Object.keys(LEGAL) as LegalKind[]).map((k) => (
              <a
                key={k}
                className="ui-btn ui-btn-ghost ui-btn-sm"
                href={LEGAL[k].path}
                aria-current={k === kind ? 'page' : undefined}
              >
                {LEGAL[k].title}
              </a>
            ))}
          </nav>
        </header>
        <main className="legal-card">
          <LegalDoc kind={kind} />
        </main>
        <p className="legal-foot">© QEVO · app.qevo.one</p>
      </div>
    </div>
  );
}
