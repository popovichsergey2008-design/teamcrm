import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { promptText } from '../../components/ui/dialog';
import { ApiError } from '../../lib/api';
import { toastSaved } from '../../lib/notifications';
import { feedback } from '../../lib/feedback';
import { indexPair } from '../pulse/pulse-api';
import { DecisionAction, DecisionCard, DecisionResult, decisionsApi, RunSummary } from './decisions-api';

const DAY = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
const plural = (n: number, one: string, few: string, many: string) => {
  const a = n % 100; const b = n % 10;
  return a > 10 && a < 20 ? many : b === 1 ? one : b > 1 && b < 5 ? few : many;
};
const MIN_PER = 2;
const newRunId = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

type Tally = Record<DecisionAction, number>;
const ZERO: Tally = { accept: 0, return: 0, close: 0, ask: 0 };

/**
 * Разбор решений по одной карточке (#4890, пп. 4–6) — живёт в «Фокусе дня», Пульс только
 * ведёт сюда. Пачка из 10 самых старых, без перехода на другие страницы; каждое решение —
 * по одной задаче (массового «Принять всё» нет). После решения — плашка с «Отменить»,
 * которое полностью возвращает задачу; после пачки — итог с «Ещё 10».
 */
export function DecisionRun({ boss, onClose, onCount, onBackToPulse }: {
  boss: boolean; onClose: () => void; onCount: (n: number) => void; onBackToPulse: () => void;
}) {
  const [runId, setRunId] = useState(newRunId);
  const [startedAt, setStartedAt] = useState(() => new Date().toISOString());
  const [batch, setBatch] = useState<DecisionCard[] | null>(null);
  const [pos, setPos] = useState(0);
  const [count, setCount] = useState<number | null>(null);
  const [tally, setTally] = useState<Tally>(ZERO);
  const [plate, setPlate] = useState<(DecisionResult & { card: DecisionCard; at: number }) | null>(null);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [recaps, setRecaps] = useState<Record<string, { text: string; source: 'ai' | 'rules' } | 'loading'>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // решённые и пропущенные в этом разборе — «Ещё 10» их не повторяет; в очереди пропущенные остаются
  const seen = useRef<Set<string>>(new Set());
  const root = useRef<HTMLElement>(null);

  const loadBatch = useCallback(async () => {
    setErr(''); setBatch(null); setPos(0); setSummary(null); setPlate(null);
    try {
      const b = await decisionsApi.batch([...seen.current]);
      setBatch(b.items); setCount(b.count); onCount(b.count);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось загрузить решения'); setBatch([]); }
  }, [onCount]);
  useEffect(() => { void loadBatch(); root.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const card = batch?.[pos] ?? null;
  useEffect(() => {
    if (!card?.taskId || recaps[card.key]) return;
    setRecaps((r) => ({ ...r, [card.key]: 'loading' }));
    decisionsApi.recap(card.taskId).then((x) => setRecaps((r) => ({ ...r, [card.key]: x })))
      .catch(() => setRecaps((r) => ({ ...r, [card.key]: { text: 'Пересказ не получился — откройте задачу.', source: 'rules' } })));
  }, [card, recaps]);

  const finish = useCallback(async () => {
    try { setSummary(await decisionsApi.summary(runId, startedAt)); }
    catch { setSummary({ decisions: tally.accept + tally.return + tally.close, asked: tally.ask, accepted: tally.accept, returned: tally.return, closed: tally.close, minutes: 0, index: null, unblocked: [], left: count ?? 0 }); }
  }, [runId, startedAt, tally, count]);

  const advance = (from: number) => {
    if (!batch) return;
    if (from + 1 >= batch.length) void finish();
    else setPos(from + 1);
  };

  const decide = async (action: DecisionAction) => {
    if (!card || busy) return;
    let note: string | null = null;
    if (action === 'return') {
      note = await promptText({ title: 'Что доработать?', description: card.assigneeName ? `Причину увидит ${card.assigneeName}` : undefined, placeholder: 'Например: не хватает скриншота результата', confirmLabel: 'На доработку', minLength: 3 });
      if (!note) return;
    }
    if (action === 'ask') {
      note = await promptText({ title: 'Ваш вопрос', description: card.taskId ? 'Уйдёт в чат задачи, задача останется в очереди' : 'Уйдёт в личный чат автору', placeholder: 'Что уточнить?', confirmLabel: 'Отправить', minLength: 3 });
      if (!note) return;
    }
    setBusy(true); setErr('');
    try {
      const r = await decisionsApi.decide({ key: card.key, action, note, runId });
      seen.current.add(card.key);
      setTally((t) => ({ ...t, [action]: t[action] + 1 }));
      setPlate({ ...r, card, at: pos });
      setCount(r.count.after); onCount(r.count.after);
      feedback('action.confirmed');
      window.dispatchEvent(new Event('teamcrm:tasks-changed'));
      advance(pos);
    } catch (e) {
      const gone = e instanceof ApiError && /нет в очереди|уже решено/i.test(e.message);
      setErr(e instanceof ApiError ? e.message : 'Не получилось');
      if (gone) { seen.current.add(card.key); advance(pos); }
    } finally { setBusy(false); }
  };

  const undo = async () => {
    if (!plate || busy) return;
    setBusy(true); setErr('');
    try {
      const r = await decisionsApi.undo(plate.actionId);
      seen.current.delete(plate.card.key);
      setTally((t) => ({ ...t, [plate.action]: Math.max(0, t[plate.action] - 1) }));
      setCount(r.count); onCount(r.count);
      // задача — снова на экране, на том же месте разбора
      setSummary(null);
      setPos(plate.at);
      setPlate(null);
      window.dispatchEvent(new Event('teamcrm:tasks-changed'));
      toastSaved('Решение отменено', r.index ? `задача вернулась в прежний статус · индекс ${indexPair(r.index.before, r.index.after)}` : 'задача вернулась в прежний статус');
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Отменить не получилось'); }
    finally { setBusy(false); }
  };

  const skip = () => { if (card) { seen.current.add(card.key); setPlate(null); advance(pos); } };

  const more = () => {
    setRunId(newRunId()); setStartedAt(new Date().toISOString()); setTally(ZERO);
    void loadBatch();
  };

  const left = batch ? Math.max(0, batch.length - pos) : 0;
  const recap = card ? recaps[card.key] : undefined;
  const progress = batch?.length ? Math.round(((summary ? batch.length : pos) / batch.length) * 100) : 0;
  const overdue = useMemo(() => (card?.deadlineAt ? Date.parse(card.deadlineAt) < Date.now() : false), [card]);

  return (
    <section ref={root} className="fp-card dr" aria-label="Разбор решений">
      {plate && (
        <div className="dr-plate" role="status">
          <span className="dr-plate-ico"><Icon name="check" size={16} /></span>
          <div className="dr-plate-text">
            <b>{plate.text}</b>
            <span className="dim">
              {[plate.notified, `ждут вашей проверки: ${plate.count.before} → ${plate.count.after}`, plate.index ? `индекс ${indexPair(plate.index.before, plate.index.after)}` : null].filter(Boolean).join(' · ')}
            </span>
          </div>
          <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" disabled={busy} onClick={() => void undo()}>Отменить</button>
        </div>
      )}

      {summary ? (
        <div className="dr-summary" aria-live="polite">
          <div className="dr-ring" aria-hidden="true">
            <svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" className="dr-ring-bg" /><circle cx="32" cy="32" r="28" className="dr-ring-fg" strokeDasharray={`${((summary.index?.after ?? 0) / 100) * 175.9} 175.9`} /></svg>
            <b>{summary.index ? Math.round(summary.index.after) : '—'}</b><span>из 100</span>
          </div>
          <div className="dr-summary-text">
            <div className="dr-cap">Разбор завершён</div>
            <div className="dr-title">
              {summary.decisions} {plural(summary.decisions, 'решение', 'решения', 'решений')} за {summary.minutes} {plural(summary.minutes, 'минуту', 'минуты', 'минут')}
              {summary.index ? ` · индекс ${indexPair(summary.index.before, summary.index.after)}` : ''}
            </div>
            <div className="dr-rows">
              <div><span>Принято</span><b>{summary.accepted}</b></div>
              <div><span>Отправлено на доработку</span><b>{summary.returned}</b></div>
              <div><span>Закрыто как неактуальное</span><b>{summary.closed}</b></div>
              {summary.asked > 0 && <div><span>Задано вопросов</span><b>{summary.asked}</b></div>}
            </div>
            <div className="dim dr-small">
              {summary.unblocked.length ? `Разблокированы: ${summary.unblocked.join(', ')}. ` : ''}Осталось на проверке: {summary.left}.
            </div>
            <div className="fp-acts">
              {summary.left > 0 && <button type="button" className="ui-btn ui-btn-primary ui-btn-md" onClick={more}>Ещё {Math.min(10, summary.left)}</button>}
              {boss
                ? <button type="button" className="ui-btn ui-btn-outline ui-btn-md" onClick={onBackToPulse}>Вернуться в Пульс</button>
                : <button type="button" className="ui-btn ui-btn-outline ui-btn-md" onClick={onClose}>Готово</button>}
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="dr-head">
            <b>Разбор решений{batch?.length ? ` · ${Math.min(pos + 1, batch.length)} из ${batch.length}` : ''}</b>
            <span className="dim dr-small">
              осталось ≈ {left * MIN_PER} мин · принято {tally.accept} · на доработку {tally.return} · закрыто как неактуальное {tally.close}
            </span>
            <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" aria-label="Свернуть разбор" onClick={onClose}><Icon name="close" size={14} /></button>
          </div>
          <div className="dr-progress" role="progressbar" aria-valuemin={0} aria-valuemax={batch?.length ?? 0} aria-valuenow={pos} aria-label="Ход разбора"><span style={{ width: `${progress}%` }} /></div>
          {!batch && <div className="dim">Собираю самые старые решения…</div>}
          {batch && batch.length === 0 && !err && <div className="dim">Решений от вас никто не ждёт{count === 0 ? '' : ' — все в этом разборе уже просмотрены'}.</div>}
          {card && (
            <article className="dr-card" aria-label={card.title}>
              <div className="dr-chips">
                {card.taskId && <span className="dr-chip">#{card.taskId}</span>}
                {card.kind === 'approval' && <span className="dr-chip">согласование</span>}
                {card.projectName && <span className="dr-chip">{card.projectName}</span>}
                <span className="dr-chip is-wait">ждёт {card.waitingDays} {plural(card.waitingDays, 'день', 'дня', 'дн.')}</span>
              </div>
              <div className="dr-title">{card.title}</div>
              <div className="dim dr-small">
                {[card.assigneeName ? `${card.kind === 'approval' ? 'Автор' : 'Исполнитель'}: ${card.assigneeName}` : null,
                  `${card.kind === 'approval' ? 'спросил' : 'сдал'} ${DAY(card.submittedAt)}`,
                  card.deadlineAt ? `срок ${overdue ? 'был' : ''} ${DAY(card.deadlineAt)}`.replace('  ', ' ') : null].filter(Boolean).join(' · ')}
                {' · '}<b className="dr-next">следующий шаг — вы</b>
              </div>
              {card.taskId && (
                <div className="dr-recap">
                  <b>{recap && recap !== 'loading' && recap.source === 'rules' ? 'Кратко (без ИИ, по задаче):' : 'Кратко от ИИ:'}</b>{' '}
                  {!recap || recap === 'loading' ? <span className="dim">читаю вложения, чек-лист и чат задачи…</span> : recap.text}
                </div>
              )}
              <div className="fp-acts">
                <button type="button" className="ui-btn ui-btn-primary ui-btn-md" disabled={busy} onClick={() => void decide('accept')}>Принять</button>
                <button type="button" className="ui-btn ui-btn-outline ui-btn-md" disabled={busy} onClick={() => void decide('return')}>На доработку</button>
                <button type="button" className="ui-btn ui-btn-outline ui-btn-md" disabled={busy} onClick={() => void decide('ask')}>Задать вопрос</button>
                <button type="button" className="ui-btn ui-btn-outline ui-btn-md" disabled={busy} onClick={() => void decide('close')}>Неактуально — закрыть</button>
                <button type="button" className="ui-btn ui-btn-ghost ui-btn-md" disabled={busy} onClick={skip}>Пропустить →</button>
              </div>
            </article>
          )}
          <div className="dim dr-small">Каждое решение — по одной задаче. Массового «Принять всё» нет.</div>
        </>
      )}
      {err && <div className="error-text" role="alert">{err}</div>}
    </section>
  );
}
