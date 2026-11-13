import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Select } from '../../components/ui/select';
import { ApiError } from '../../lib/api';
import { showToast } from '../../lib/notifications';
import { feedback } from '../../lib/feedback';
import { Balance, pulseApi } from './pulse-api';

const h = (v: number) => `${Math.round(v * 10) / 10} ч`.replace('.', ',');

/**
 * «Балансировать» (#4890, п. 9): предпросмотр переноса — было → стало в задачах и в часах
 * по оценкам, без процентов. Совет ИИ стоит по умолчанию, выбрать можно любого или «не
 * передавать». Ничего не переносится до «Передать». Сроки задач не меняются.
 */
export function BalanceDialog({ userId, taskIds, toId, onClose, onDone }: {
  userId: string; taskIds?: string[]; toId?: string | null; onClose: () => void; onDone: () => void;
}) {
  const [r, setR] = useState<Balance | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    pulseApi.balance(userId, { taskIds, toId }).then((x) => {
      setR(x);
      setPick(Object.fromEntries(x.items.map((i) => [i.taskId, i.toId ?? ''])));
    }).catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось подобрать'));
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => { if (r?.id) void pulseApi.reject(r.id).catch(() => undefined); onClose(); };
  const items = useMemo(() => r?.items ?? [], [r]);
  const moved = useMemo(() => {
    const to = new Map<string, { n: number; h: number }>();
    let n = 0; let hours = 0;
    for (const it of items) {
      const dest = pick[it.taskId];
      if (!dest) continue;
      const cur = to.get(dest) ?? { n: 0, h: 0 };
      to.set(dest, { n: cur.n + 1, h: cur.h + (it.hours ?? 0) });
      n += 1; hours += it.hours ?? 0;
    }
    return { to, n, hours };
  }, [items, pick]);
  const changed = items.some((it) => (pick[it.taskId] ?? '') !== (it.toId ?? ''));
  const options = (allowed: string[] | null) => [
    { value: '', label: 'Не передавать' },
    ...(r?.people ?? []).filter((p) => !allowed || allowed.includes(p.id)).map((p) => ({
      value: p.id, label: `${p.name} · в работе ${p.active + (moved.to.get(p.id)?.n ?? 0)}${p.available ? '' : ' · не на месте'}`,
    })),
  ];
  return (
    <Dialog open onOpenChange={(o) => { if (!o) close(); }} title={`Балансировка${r?.fromName ? `: ${r.fromName}` : ''}`} size="md"
      description="Предпросмотр: было → стало. Сроки задач не меняются, ничего не переносится без подтверждения."
      footer={(
        <>
          <Button variant="ghost" onClick={close}>Отмена</Button>
          {r?.id && (
            <Button variant="primary" loading={busy} disabled={!moved.n} onClick={async () => {
              setBusy(true);
              try {
                const moves = changed ? items.map((it) => ({ taskId: it.taskId, toId: pick[it.taskId] || null })) : undefined;
                const x = await pulseApi.confirm(r.id!, moves);
                feedback('action.confirmed'); showToast({ kind: 'saved', title: 'Балансировка', body: x.text }); onDone(); onClose();
              } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
              finally { setBusy(false); }
            }}>{moved.n ? `Передать: ${moved.n}` : 'Передать'}</Button>
          )}
        </>
      )}>
      {!r && !err && <div className="dim">Подбираю, кому передать…</div>}
      {r?.note && <div className="dim">{r.note}</div>}
      {items.map((it) => (
        <div key={it.taskId} className="pulse-move">
          <b>#{it.taskId} {it.title}</b>
          <Select ariaLabel={`Кому передать #${it.taskId}`} size="sm" className="pulse-move-to" value={pick[it.taskId] ?? ''}
            onValueChange={(v) => setPick((p) => ({ ...p, [it.taskId]: v }))} options={options(it.allowedIds)} />
          <span className="dim">{it.hours != null ? `оценка ${h(it.hours)}` : 'без оценки'}{it.deadlineAt ? ` · срок ${new Date(it.deadlineAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}` : ''}</span>
          {it.toId && it.reason && <span className="dim"><Icon name="sparkles" size={11} /> {it.reason}</span>}
        </div>
      ))}
      {r && items.length > 0 && (
        <div className="pulse-preview" aria-live="polite">
          <div><b>{r.fromName}</b>: в работе {r.fromActive} → {r.fromActive - moved.n}{r.fromEstimated ? ` · по оценкам ${h(r.fromHours)} → ${h(Math.max(0, r.fromHours - moved.hours))}` : ''}</div>
          {(r.people ?? []).filter((p) => moved.to.has(p.id)).map((p) => (
            <div key={p.id}>{p.name}: в работе {p.active} → {p.active + moved.to.get(p.id)!.n}{p.estimated || moved.to.get(p.id)!.h ? ` · по оценкам ${h(p.hours)} → ${h(p.hours + moved.to.get(p.id)!.h)}` : ''}</div>
          ))}
        </div>
      )}
      {err && <div className="error-text">{err}</div>}
    </Dialog>
  );
}
