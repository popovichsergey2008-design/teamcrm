import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { Dialog } from '../ui/dialog';
import { LegalDoc } from './LegalDoc';
import { LEGAL, type LegalKind } from '../../legal';

function LegalHost({ kind, onDone }: { kind: LegalKind; onDone: () => void }) {
  const [open, setOpen] = useState(true);
  const meta = LEGAL[kind];
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => { setOpen(v); if (!v) onDone(); }}
      title={meta.title}
      size="lg"
      footer={(
        <>
          <a className="ui-btn ui-btn-ghost ui-btn-sm legal-dialog-open" href={meta.path} target="_blank" rel="noopener">
            Открыть отдельной страницей
          </a>
          <button type="button" className="ui-btn ui-btn-primary ui-btn-md" onClick={() => { setOpen(false); onDone(); }}>
            Понятно
          </button>
        </>
      )}
    >
      <div className="legal-dialog-body">
        <LegalDoc kind={kind} inDialog />
      </div>
    </Dialog>
  );
}

/**
 * Показать политику поверх текущего экрана (#4675): форма регистрации или окно
 * согласия остаются как были — ничего из заполненного не теряется. Так же и в
 * приложении на телефоне, где «новая вкладка» увела бы во внешний браузер.
 */
export function openLegal(kind: LegalKind): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const done = () => window.setTimeout(() => { root.unmount(); host.remove(); }, 200);
  root.render(<LegalHost kind={kind} onDone={done} />);
}
