import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { ApiError } from '../../lib/api';
import { getSocket } from '../../lib/socket';
import { toastSaved } from '../../lib/notifications';
import { dur, focusApi, hm, Replan as R, ReplanSlot } from './focus-api';

/**
 * Пришло срочное (#4891, п. 7): «Сейчас» и «Предложение ИИ» рядом — срочное встаёт в
 * резерв, главные задачи не двигаются. Видно источник, откуда срок и сколько резерва
 * съедено. Без «Принять» план не меняется; принятое — «Вернуть как было» до конца дня.
 */
export function Replan({ onChanged }: { onChanged: () => void }) {
  const [r, setR] = useState<R | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { void focusApi.replan().then(setR).catch(() => undefined); }, []);
  useEffect(() => {
    load();
    const s = getSocket();
    s.on('focus.day.updated', load);
    window.addEventListener('teamcrm:tasks-changed', load);
    return () => { s.off('focus.day.updated', load); window.removeEventListener('teamcrm:tasks-changed', load); };
  }, [load]);
  const act = async (fn: () => Promise<R>, msg: string) => {
    setBusy(true);
    try { setR(await fn()); toastSaved(msg); onChanged(); }
    catch (e) { toastSaved('Не получилось', e instanceof ApiError ? e.message : ''); }
    finally { setBusy(false); }
  };
  if (!r) return null;
  const u = r.urgent;
  if (!u) {
    return r.revertable ? (
      <div className="fp-revert" role="status">
        <Icon name="zap" size={14} /> В план добавлено срочное: «{r.revertable.title}».
        <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" disabled={busy} onClick={() => void act(focusApi.replanRevert, 'План вернулся, как был')}>Вернуть как было</button>
      </div>
    ) : null;
  }
  const col = (title: string, list: ReplanSlot[] | undefined) => (
    <div className="fp-rp-col">
      <div className="fp-small dim">{title}</div>
      {(list ?? []).filter((s) => s.kind !== 'lunch').map((s, i) => (
        <div key={`${s.kind}${i}`} className={`fp-rp-slot ${s.kind}`}>
          <span className="dim fp-small">{hm(s.startsAt)}</span>
          <span>{s.kind === 'reviews' ? 'Проверки и решения' : s.kind === 'reserve' ? 'Резерв' : s.title}</span>
        </div>
      ))}
    </div>
  );
  return (
    <section className="fp-card fp-replan" aria-label="Пришло срочное">
      <div className="fp-head"><b><Icon name="zap" size={15} /> Пришло срочное: {u.title}</b></div>
      <div className="dim fp-small">
        Источник: {u.source.label}{u.source.quote ? ` — «${u.source.quote}»` : ''} · {u.deadline} ·{' '}
        {u.fits ? `займёт ${dur(u.reserveEaten)} резерва, останется ${dur(u.reserveLeft)}` : 'в резерве сегодня нет места'}
      </div>
      <div className="fp-rp-cols">
        {col('Сейчас', r.before)}
        {col('Предложение ИИ', r.after)}
      </div>
      <div className="dim fp-small">Главные задачи не сдвигаются; срок задач не меняется.</div>
      <div className="fp-acts">
        {u.fits && <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" disabled={busy} onClick={() => void act(() => focusApi.replanDo('accept', u.key), 'Срочное — в резерве')}>Принять</button>}
        <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" disabled={busy} onClick={() => void act(() => focusApi.replanDo('keep', u.key), 'План остался прежним')}>Оставить план</button>
        <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" disabled={busy} onClick={() => void act(() => focusApi.replanDo('inbox', u.key), 'Отложено во входящие')}>Отложить во входящие</button>
      </div>
    </section>
  );
}
