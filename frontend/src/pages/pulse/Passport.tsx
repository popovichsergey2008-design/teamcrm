import { useEffect, useState } from 'react';
import './passport.css';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { ApiError } from '../../lib/api';
import { navigate } from '../../lib/router';
import { decisionsApi, DecisionListItem } from '../focus/decisions-api';
import type { Passport } from './pulse-api';

const updated = (iso: string) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return `${today ? 'сегодня' : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })} ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
};

/**
 * Паспорт числа (#4890, п. 3): что считается, период, охват, когда обновлено, связанные
 * числа и «Открыть список» — в списке ровно столько строк, сколько на кнопке.
 */
export function PassportDialog({ load, onClose, onOpenList }: {
  load: () => Promise<Passport>; onClose: () => void; onOpenList?: () => void;
}) {
  const [p, setP] = useState<Passport | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { load().then(setP).catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось открыть паспорт числа')); }, [load]);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} size="md" title={p ? p.title : 'Что за число'}
      description="Что за число"
      footer={(
        <>
          {p?.list && onOpenList && <Button variant="primary" onClick={onOpenList}>{p.list.label} · {p.list.count}</Button>}
          <Button variant="outline" onClick={onClose}>Закрыть</Button>
        </>
      )}>
      {!p && !err && <div className="dim">Загружаю…</div>}
      {err && <div className="error-text">{err}</div>}
      {p && (
        <dl className="pp-rows">
          <div><dt>Что считается</dt><dd>{p.what}</dd></div>
          <div><dt>Период</dt><dd>{p.period}</dd></div>
          <div><dt>Охват</dt><dd>{p.scope}</dd></div>
          <div><dt>Обновлено</dt><dd>{updated(p.updatedAt)}</dd></div>
          {p.related.length > 0 && (
            <div><dt>Связанные числа</dt><dd>{p.related.map((r) => `${r.label} — ${r.value}`).join(' · ')}</dd></div>
          )}
        </dl>
      )}
    </Dialog>
  );
}

/** Список «ждут вашего решения» — те же строки, из которых считается число (п. 3). */
export function DecisionListDialog({ onClose, onStart }: { onClose: () => void; onStart?: () => void }) {
  const [data, setData] = useState<{ count: number; items: DecisionListItem[] } | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { decisionsApi.list().then(setData).catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось загрузить список')); }, []);
  const open = (i: DecisionListItem) => {
    onClose();
    if (i.taskId && i.projectId) navigate({ section: 'projects', projectId: i.projectId, taskId: i.taskId });
    else navigate({ section: 'focus' });
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} size="lg"
      title={data ? `Ждут вашего решения — ${data.count}` : 'Ждут вашего решения'}
      footer={onStart && data && data.count > 0 ? <Button variant="primary" onClick={() => { onClose(); onStart(); }}>Начать разбор · {Math.min(10, data.count)} шт.</Button> : undefined}>
      {!data && !err && <div className="dim">Загружаю…</div>}
      {err && <div className="error-text">{err}</div>}
      {data && data.items.length === 0 && <div className="dim">Решений от вас никто не ждёт.</div>}
      {data?.items.map((i) => (
        <div key={i.key} className="pp-item">
          <button type="button" className="pp-link" onClick={() => open(i)}>
            {i.taskId ? `#${i.taskId} ` : ''}{i.title}
          </button>
          <span className="dim">
            {[i.kind === 'approval' ? 'согласование' : 'проверка', i.projectName, i.assigneeName, `ждёт ${i.waitingDays} дн.`,
              i.deadlineAt && Date.parse(i.deadlineAt) < Date.now() ? 'срок прошёл' : null].filter(Boolean).join(' · ')}
          </span>
        </div>
      ))}
    </Dialog>
  );
}
