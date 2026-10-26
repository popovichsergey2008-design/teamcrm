import { useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { api, type HubDecision, type HubItem, type HubRun } from '../../lib/api';
import { addedSummary, dayLabel } from '../../lib/hub';
import { DecisionRow, ItemRow, errText } from './parts';

type RunItem = HubItem & { removed?: boolean };

/**
 * «Что добавил ИИ» — разбор утреннего сбора.
 *
 * Библиотекарь ничего не спрашивает заранее: он кладёт, а человек снимает лишнее
 * одним нажатием. Поэтому у каждой записи — «Убрать», а убранное остаётся в списке
 * зачёркнутым: видно, что именно сняли, и случайное нажатие заметно сразу.
 * Открыли окно — бейдж гаснет (seen), второй раз то же самое не показываем.
 */
export function HubRunDialog({ projectId, runId, onClose, onChanged }: {
  projectId: string;
  runId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [run, setRun] = useState<HubRun | null>(null);
  const [items, setItems] = useState<RunItem[]>([]);
  const [decisions, setDecisions] = useState<HubDecision[]>([]);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    api.hubRun(projectId, runId)
      .then((r) => { if (!alive) return; setRun(r.run); setItems(r.items); setDecisions(r.decisions); })
      .catch((e) => alive && setErr(errText(e, 'Не удалось загрузить, что добавил ИИ')))
      .finally(() => alive && setLoading(false));
    api.hubSeen(projectId, runId).then(onChanged).catch(() => undefined);
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, runId]);

  const remove = async (it: RunItem) => {
    setErr('');
    setItems((xs) => xs.map((x) => (x.id === it.id ? { ...x, removed: true } : x)));
    try { await api.hubRemoveItem(projectId, it.id); onChanged(); }
    catch (e) {
      setItems((xs) => xs.map((x) => (x.id === it.id ? { ...x, removed: false } : x)));
      setErr(errText(e, 'Не удалось убрать запись'));
    }
  };

  const summary = run ? addedSummary(run.added) : '';
  return (
    <Dialog
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title="Что добавил ИИ"
      description={run ? `Сбор ${dayLabel(run.runDate)}${summary ? `: ${summary}` : ''}. Лишнее уберите — остальное останется в Инфоцентре.` : undefined}
      size="lg"
      footer={<Button variant="primary" size="sm" onClick={onClose}>Готово</Button>}
    >
      <div className="hub-run">
        {err && <p className="hub-err" role="alert">{err}</p>}
        {loading && <p className="hub-hint" role="status">Загружаю…</p>}
        {!loading && !err && !items.length && !decisions.length && (
          <p className="hub-hint">В этот раз ИИ ничего нового не нашёл.</p>
        )}
        {items.length > 0 && (
          <ul className="hub-list">
            {items.map((it) => (
              <li key={it.id} className={`hub-run-item${it.removed ? ' is-removed' : ''}`}>
                <ul className="hub-list"><ItemRow item={it} onError={setErr} /></ul>
                {it.removed
                  ? <span className="hub-run-removed">Убрано</span>
                  : <Button variant="outline" size="sm" onClick={() => void remove(it)}><Icon name="close" size={13} /> Убрать</Button>}
              </li>
            ))}
          </ul>
        )}
        {decisions.length > 0 && (
          <>
            <h3 className="hub-sub">Решения за сутки</h3>
            <ul className="hub-list">{decisions.map((d) => <DecisionRow key={d.id} d={d} />)}</ul>
            <p className="hub-hint">Решения ИИ не копирует — они берутся из созвонов и чатов. Отменить решение можно в итогах созвона.</p>
          </>
        )}
      </div>
    </Dialog>
  );
}
