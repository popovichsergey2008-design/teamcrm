import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { SkeletonList } from '../components/Skeleton';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { api, ApiError, FocusToday } from '../lib/api';
import { CloseSummary2, focusApi } from './focus/focus-api';

type When = 'tomorrow' | 'date' | 'inbox';

/**
 * «Завершить день» за 2 минуты (ТЗ-16, п. 80–86; #4891, п. 10).
 *
 * Открывается только по нажатию (или из мягкого напоминания в конце рабочего дня). Тон —
 * без упрёков: «Хороший день: 2 из 3». По каждой незавершённой — что сделано, следующий шаг
 * и «Завтра 10:00» / «Выбрать день» / «Во входящие»: ставится время в календаре, срок задачи
 * не меняется. «Завтра начните с…» — первая строка утреннего брифа. После — «Не в сети».
 */
export function CloseDayDialog({ open, onClose, onClosed }: {
  open: boolean;
  onClose: () => void;
  onClosed: (next: FocusToday) => void;
}) {
  const [sum, setSum] = useState<CloseSummary2 | null>(null);
  const [plan, setPlan] = useState<Record<string, { when: When; date: string; step: string }>>({});
  const [startWith, setStartWith] = useState('');
  const [quiet, setQuiet] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!open) return;
    setSum(null); setErr(''); setStartWith('');
    focusApi.closeSummary()
      .then((s) => {
        setSum(s); setQuiet(s.quietDefault);
        setPlan(Object.fromEntries(s.remaining.map((r) => [r.id, { when: 'inbox' as When, date: '', step: r.nextStep ?? '' }])));
      })
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось собрать итоги'));
  }, [open]);

  const set = (id: string, patch: Partial<{ when: When; date: string; step: string }>) =>
    setPlan((p) => ({ ...p, [id]: { ...p[id], ...patch } }));

  const finish = async () => {
    if (!sum) return;
    setBusy(true); setErr('');
    try {
      await focusApi.close({
        startWith: startWith.trim() || null, quiet,
        items: sum.remaining.map((r) => {
          const p = plan[r.id];
          return { itemId: r.id, taskId: r.taskId, nextStep: r.taskId && p.step !== (r.nextStep ?? '') ? p.step : undefined, when: p.when, date: p.when === 'date' ? p.date : null };
        }),
      });
      onClosed(await api.focusToday());
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не получилось — попробуйте ещё раз');
    } finally {
      setBusy(false);
    }
  };

  const all = sum && sum.topTotal > 0 && sum.topDone === sum.topTotal;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={sum ? sum.headline : 'Итоги дня'}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>Не сейчас</Button>
          <Button variant="primary" disabled={busy || !sum} onClick={() => void finish()}><Icon name="moon" size={15} /> Завершить день</Button>
        </>
      )}
    >
      {!sum && !err && <SkeletonList rows={3} />}
      {err && <div className="error-text" role="alert">{err}</div>}
      {sum && (
        <div className="fd-close">
          {all && <div className="fd-close-win" aria-hidden="true"><Icon name="check-circle" size={40} /></div>}
          <div className="fd-close-stats">
            <div><b>{sum.topDone} из {sum.topTotal}</b><span>результатов готово</span></div>
            <div><b>{sum.deepHours}</b><span>глубокой работы</span></div>
            <div><b>{sum.reviewsDone}</b><span>проверок и решений разобрано</span></div>
            <div><b>{sum.moved}</b><span>задач сдвинулось</span></div>
          </div>

          {sum.remaining.map((r) => {
            const p = plan[r.id];
            if (!p) return null;
            return (
              <section key={r.id} className="fd-close-item">
                <b>{r.title ?? 'Задача недоступна'}</b>
                {r.done.length > 0 && <div className="dim fp-small">Сделано: {r.done.join(' · ')}</div>}
                {r.taskId && (
                  <input className="input" value={p.step} placeholder="Следующий шаг" aria-label={`Следующий шаг: ${r.title ?? ''}`}
                    onChange={(e) => set(r.id, { step: e.target.value })} />
                )}
                {r.taskId && r.kind === 'task' && (
                  <div className="fd-close-when" role="group" aria-label="Когда продолжить">
                    {([['tomorrow', 'Завтра 10:00'], ['date', 'Выбрать день'], ['inbox', 'Во входящие']] as [When, string][]).map(([w, label]) => (
                      <button key={w} type="button" className={`fd-chip${p.when === w ? ' on' : ''}`} aria-pressed={p.when === w} onClick={() => set(r.id, { when: w })}>{label}</button>
                    ))}
                    {p.when === 'date' && <input className="input fp-date" type="date" value={p.date} min={new Date().toISOString().slice(0, 10)} onChange={(e) => set(r.id, { date: e.target.value })} aria-label="День" />}
                  </div>
                )}
              </section>
            );
          })}
          {sum.remaining.length > 0 && <p className="dim fp-small">Срок задач не меняется — ставится только время в календаре.</p>}

          <label className="fd-close-start">
            <span>Завтра начните с…</span>
            <input className="input" value={startWith} maxLength={500} placeholder="Например: созвон с Иваном по отчёту" onChange={(e) => setStartWith(e.target.value)} />
            <span className="dim fp-small">Этой строкой начнётся утренний бриф</span>
          </label>
          <label className="fd-close-quiet">
            <input type="checkbox" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} />
            «Не в сети» и тишина до начала следующего рабочего дня
            <span className="dim">срочные стуки и безопасность всё равно дойдут</span>
          </label>
        </div>
      )}
    </Dialog>
  );
}
