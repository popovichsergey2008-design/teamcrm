import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { SkeletonList } from '../components/Skeleton';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { api, ApiError, FocusCloseSummary, FocusToday } from '../lib/api';

const plural = (n: number, one: string, few: string, many: string) => {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
};

/**
 * «Завершить день и подвести итоги» (ТЗ-16, п. 80–86).
 *
 * Открывается только по нажатию — поверх работы сама не выскакивает. Тон — без
 * упрёков: «завершено 2 из 3», а не «вы не успели». Хвосты не уезжают «на завтра»
 * скопом: всё возвращается в общий список, и утром тройка соберётся заново; на
 * завтра закрепляется только то, что человек отметил сам.
 */
export function CloseDayDialog({ open, onClose, onClosed }: {
  open: boolean;
  onClose: () => void;
  onClosed: (next: FocusToday) => void;
}) {
  const [sum, setSum] = useState<FocusCloseSummary | null>(null);
  const [tomorrow, setTomorrow] = useState<Set<string>>(new Set());
  const [quiet, setQuiet] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!open) return;
    setSum(null); setErr(''); setTomorrow(new Set());
    api.focusCloseSummary()
      .then((s) => { setSum(s); setQuiet(s.quietDefault); })
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось собрать итоги'));
  }, [open]);

  const finish = async () => {
    setBusy(true); setErr('');
    try {
      onClosed(await api.focusClose([...tomorrow], quiet));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не получилось — попробуйте ещё раз');
    } finally {
      setBusy(false);
    }
  };

  const all = sum && sum.topTotal > 0 && sum.topDone === sum.topTotal;
  const toggle = (id: string) => setTomorrow((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={all ? 'Отличная работа!' : 'Итоги дня'}
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
            <div><b>{sum.topDone} / {sum.topTotal}</b><span>главных действий</span></div>
            <div><b>{sum.deepMinutes}</b><span>{plural(sum.deepMinutes, 'минута', 'минуты', 'минут')} глубокого фокуса</span></div>
            <div><b>{sum.unblocked}</b><span>разблокировано задач коллег</span></div>
            <div><b>{sum.meetings}</b><span>{plural(sum.meetings, 'встреча', 'встречи', 'встреч')}</span></div>
          </div>

          {sum.remaining.length > 0 && (
            <section>
              <p>Сегодня завершено {sum.topDone} из {sum.topTotal} главных действий. {sum.remaining.length === 1 ? 'Осталось:' : 'Остались:'}</p>
              {sum.remaining.map((i) => (
                <label key={i.id} className="fd-close-left">
                  {i.kind === 'task' && i.taskId
                    ? <input type="checkbox" checked={tomorrow.has(i.id)} onChange={() => toggle(i.id)} />
                    : <span className="fd-close-dot" aria-hidden="true" />}
                  <span>
                    {i.title ?? 'Задача недоступна'}
                    {i.kind === 'task' && i.taskId && <span className="dim"> — закрепить на завтра</span>}
                  </span>
                </label>
              ))}
              <p className="dim">Что не закрепите, вернётся в общий список — утром фокус соберётся заново.</p>
            </section>
          )}
          {sum.secondaryLeft > 0 && (
            <p className="dim">
              Ещё {sum.secondaryLeft} {plural(sum.secondaryLeft, 'второстепенное действие', 'второстепенных действия', 'второстепенных действий')} останутся в списке — ничего не потеряется.
            </p>
          )}
          <label className="fd-close-quiet">
            <input type="checkbox" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} />
            Тихий режим до начала следующего рабочего дня
            <span className="dim">срочные стуки и безопасность всё равно дойдут</span>
          </label>
        </div>
      )}
    </Dialog>
  );
}
