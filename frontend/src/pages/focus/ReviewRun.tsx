import { useState } from 'react';
import { Icon } from '../../components/Icon';
import { Dialog, promptText } from '../../components/ui/dialog';
import { api, ApiError, FocusCandidate } from '../../lib/api';
import { toastSaved } from '../../lib/notifications';

/**
 * Разбор проверок и решений по одной карточке (#4891, п. 4): решил — следующая, без
 * возврата к списку. Согласование — «Согласовать» / «Отказать»; проверка — «Открыть и принять».
 */
export function ReviewRun({ items, onOpenTask, onClose }: {
  items: FocusCandidate[]; onOpenTask: (projectId: string | null, taskId: string) => void; onClose: (changed: boolean) => void;
}) {
  const [i, setI] = useState(0);
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(false);
  const c = items[i];
  const next = () => { if (i + 1 >= items.length) { toastSaved('Разбор закончен', `разобрано: ${items.length}`); onClose(true); } else setI(i + 1); };
  const decide = async (approve: boolean) => {
    if (!c?.approvalId) return;
    let note: string | undefined;
    if (!approve) {
      const t = await promptText({ title: 'Почему отказываете?', placeholder: 'Причину увидит автор', confirmLabel: 'Отказать', minLength: 3 });
      if (!t) return;
      note = t;
    }
    setBusy(true);
    try { await api.decideApproval(c.approvalId, approve, note); setChanged(true); window.dispatchEvent(new Event('teamcrm:tasks-changed')); next(); }
    catch (e) { toastSaved('Не получилось', e instanceof ApiError ? e.message : ''); }
    finally { setBusy(false); }
  };
  if (!c) return null;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(changed); }} size="md" title={`Разбор · ${i + 1} из ${items.length}`}>
      <div className="fp-run">
        <div className="fp-maintitle">{c.title}</div>
        {c.projectName && <div className="dim fp-small">{c.projectName}</div>}
        {c.reasons.length > 0 && <ul className="fd-why">{c.reasons.slice(0, 3).map((r) => <li key={r}>{r}</li>)}</ul>}
        <div className="fp-acts">
          {c.kind === 'approval' ? (
            <>
              <button type="button" className="ui-btn ui-btn-primary ui-btn-md" disabled={busy} onClick={() => void decide(true)}><Icon name="check" size={14} /> Согласовать</button>
              <button type="button" className="ui-btn ui-btn-outline ui-btn-md" disabled={busy} onClick={() => void decide(false)}>Отказать</button>
            </>
          ) : c.taskId && (
            <button type="button" className="ui-btn ui-btn-primary ui-btn-md" onClick={() => { onOpenTask(null, c.taskId!); setChanged(true); }}><Icon name="check-circle" size={14} /> Открыть и принять</button>
          )}
          <button type="button" className="ui-btn ui-btn-ghost ui-btn-md" onClick={next}>{i + 1 >= items.length ? 'Готово' : 'Дальше'}</button>
        </div>
      </div>
    </Dialog>
  );
}
