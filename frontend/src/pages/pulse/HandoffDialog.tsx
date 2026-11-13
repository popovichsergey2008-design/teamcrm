import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Select } from '../../components/ui/select';
import { ApiError } from '../../lib/api';
import { showToast } from '../../lib/notifications';
import { feedback } from '../../lib/feedback';
import { Handoff, pulseApi } from './pulse-api';

/**
 * «Передать часть» (#4890, п. 2): самые старые проверки — коллеге с наименьшей очередью.
 * Предпросмотр «было → стало» по очередям; проверяющий меняется только по «Передать».
 */
export function HandoffDialog({ fromId, toId, count, onClose, onDone }: {
  fromId: string; toId?: string | null; count?: number; onClose: () => void; onDone: () => void;
}) {
  const [h, setH] = useState<Handoff | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (to?: string | null) => {
    setErr('');
    try {
      if (h?.id) void pulseApi.reject(h.id).catch(() => undefined);
      setH(await pulseApi.handoff({ fromId, toId: to ?? undefined, count }));
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось подготовить'); }
  }, [fromId, count, h?.id]);
  useEffect(() => { void load(toId); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => { if (h?.id) void pulseApi.reject(h.id).catch(() => undefined); onClose(); };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) close(); }} size="md" title="Передать часть проверок"
      description="Проверяющим станет коллега; исполнители и сроки не меняются."
      footer={(
        <>
          <Button variant="ghost" onClick={close}>Отмена</Button>
          {h && <Button variant="primary" loading={busy} onClick={async () => {
            setBusy(true);
            try {
              const r = await pulseApi.confirm(h.id);
              feedback('action.confirmed'); showToast({ kind: 'saved', title: 'Проверки переданы', body: r.text }); onDone(); onClose();
            } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
            finally { setBusy(false); }
          }}>Передать {h.tasks.length}</Button>}
        </>
      )}>
      {!h && !err && <div className="dim">Готовлю предпросмотр…</div>}
      {h && (
        <>
          <Select ariaLabel="Кому передать" value={h.to.id} onValueChange={(v) => void load(v)}
            options={h.candidates.map((c) => ({ value: c.id, label: `${c.name} · на проверке ${c.queue}` }))} />
          <div className="pulse-preview">
            <div>{h.from.name}: ждут проверки {h.before.from} → {h.after.from}</div>
            <div>{h.to.name}: ждут проверки {h.before.to} → {h.after.to}</div>
          </div>
          <ul className="pulse-plan">
            {h.tasks.map((t) => <li key={t.id}>#{t.id} {t.title} <span className="dim">· ждёт {t.days} дн.</span></li>)}
          </ul>
        </>
      )}
      {err && <div className="error-text">{err}</div>}
    </Dialog>
  );
}
