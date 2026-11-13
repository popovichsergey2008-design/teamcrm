import { useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { DropdownMenu, MenuItem } from '../../components/ui/dropdown-menu';
import { ApiError, FocusCandidate } from '../../lib/api';
import { toastSaved } from '../../lib/notifications';
import { dur, focusApi, MainCard as Card } from './focus-api';

/**
 * Карточка главного результата (#4891, п. 3): название, «Главный результат дня · 1 из 3»,
 * следующий шаг, ожидаемый результат, оценка. Одна главная кнопка «▶ Начать фокус» и
 * «Открыть задачу», остальное — в «···». Оценки нет — ИИ предлагает «≈ 2 ч · верно / изменить»;
 * подтверждённая записывается в задачу. Шага нет — подсказка «Какой первый шаг?», без выдумок.
 */
export function MainCard({ card, minutes, onMinutes, onStart, onOpen, onTakeToWork, onWhy, reasons, busy }: {
  card: Card; minutes: number; onMinutes: (m: number) => void;
  onStart: () => void; onOpen: () => void; onTakeToWork?: () => void; onWhy: () => void; reasons: string[]; busy: boolean;
}) {
  const [est, setEst] = useState(card.estimate);
  const [editEst, setEditEst] = useState<string | null>(null);
  const [step, setStep] = useState(card.nextStep ?? '');
  const [result, setResult] = useState(card.result ?? '');
  const [stepSrc, setStepSrc] = useState<string | null>(card.nextStep ? 'saved' : null);
  const [showWhy, setShowWhy] = useState(false);
  useEffect(() => {
    setEst(card.estimate); setStep(card.nextStep ?? ''); setResult(card.result ?? '');
    if (!card.taskId) return;
    // шаг из чек-листа, если записанного нет
    void focusApi.note(card.taskId).then((n) => { if (!card.nextStep && n.nextStep) { setStep(n.nextStep); setStepSrc(n.nextStepSource); } }).catch(() => undefined);
    // оценки нет — просим ИИ (без ключа — по чек-листу, честно «≈»)
    if (!card.estimate) void focusApi.suggest(card.taskId).then((s) => setEst({ minutes: s.minutes, source: s.source === 'task' ? 'task' : 'ai' })).catch(() => undefined);
  }, [card.taskId, card.estimate, card.nextStep, card.result]);
  const save = (patch: { nextStep?: string; result?: string }) => {
    if (!card.taskId) return;
    void focusApi.saveNote(card.taskId, patch).then(() => toastSaved('Сохранено')).catch(() => undefined);
  };
  const confirm = async (m: number) => {
    if (!card.taskId) return;
    try { await focusApi.confirm(card.taskId, m); setEst({ minutes: m, source: 'task' }); setEditEst(null); toastSaved('Оценка записана в задачу', dur(m)); }
    catch (e) { toastSaved('Не получилось', e instanceof ApiError ? e.message : ''); }
  };
  return (
    <article className="fp-card fp-maincard" aria-label="Главный результат дня">
      <div className="fp-head">
        <span className="fp-kicker">Главный результат дня · {card.position} из {card.of}</span>
        <span className="dim fp-small">{card.taskId ? `#${card.taskId}` : ''}{card.projectName ? ` · ${card.projectName}` : ''}{card.deadlineAt ? ` · срок ${new Date(card.deadlineAt).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}` : ''}</span>
      </div>
      <h2 className="fp-maintitle">{card.title}</h2>
      <div className="fp-row">
        <span className="dim">Следующий шаг</span>
        <input className="fp-inline" value={step} placeholder="Какой первый шаг?" aria-label="Следующий шаг"
          onChange={(e) => { setStep(e.target.value); setStepSrc('saved'); }} onBlur={() => { if (stepSrc === 'saved' && step !== (card.nextStep ?? '')) save({ nextStep: step }); }} />
      </div>
      <div className="fp-row">
        <span className="dim">Результат</span>
        <input className="fp-inline" value={result} placeholder="Что будет готово? Например: список ошибок в задаче" aria-label="Ожидаемый результат"
          onChange={(e) => setResult(e.target.value)} onBlur={() => { if (result !== (card.result ?? '')) save({ result }); }} />
      </div>
      <div className="fp-row">
        <span className="dim">Оценка</span>
        {editEst !== null ? (
          <span className="fp-est">
            <input className="fp-inline fp-num" value={editEst} onChange={(e) => setEditEst(e.target.value)} aria-label="Оценка, минут" /> мин
            <button type="button" className="fp-link" onClick={() => { const m = Number(editEst); if (m >= 5) void confirm(m); }}>сохранить</button>
          </span>
        ) : est ? (
          <span className="fp-est">
            {est.source === 'task' ? dur(est.minutes) : <>≈ {dur(est.minutes)} <span className="fp-pill">предложил ИИ</span>{' '}
              <button type="button" className="fp-link" onClick={() => void confirm(est.minutes)}>верно</button> · </>}
            <button type="button" className="fp-link" onClick={() => setEditEst(String(est.minutes))}>изменить</button>
          </span>
        ) : <span className="dim">считаю…</span>}
      </div>
      <div className="fp-acts">
        <button type="button" className="ui-btn ui-btn-primary" disabled={busy || !card.taskId} onClick={onStart}><Icon name="play" size={14} /> Начать фокус · {minutes} мин</button>
        <button type="button" className="ui-btn ui-btn-outline" disabled={!card.taskId} onClick={onOpen}>Открыть задачу</button>
        <DropdownMenu align="start" trigger={<button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" aria-label="Ещё">··· ещё</button>}>
          {onTakeToWork && <MenuItem icon={<Icon name="play" size={14} />} onSelect={onTakeToWork}>Взять в работу</MenuItem>}
          <MenuItem icon={<Icon name="sparkles" size={14} />} onSelect={() => { setShowWhy((v) => !v); onWhy(); }}>Почему эта задача?</MenuItem>
          {[25, 50, 90].map((m) => <MenuItem key={m} onSelect={() => onMinutes(m)}>Фокус {m} мин{m === minutes ? ' ✓' : ''}</MenuItem>)}
        </DropdownMenu>
      </div>
      {showWhy && reasons.length > 0 && <ul className="fd-why">{reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
    </article>
  );
}

/**
 * Проверки одним блоком и быстрые дела (#4891, п. 4): «10 проверок · ≈ 1 ч · в 15:00» с
 * «Начать разбор» (по одной карточке); согласования до 5 минут — «Сделать подряд»;
 * у решения — «Отложить до…» и «Напомнить»: отложенное уходит из счётчика до даты.
 */
export function ReviewsBlock({ count, minutes, at, decisions, onStart, onSnoozed }: {
  count: number; minutes: number; at: string | null; decisions: FocusCandidate[];
  onStart: (list: FocusCandidate[]) => void; onSnoozed: () => void;
}) {
  const quick = decisions.filter((d) => d.kind === 'approval');
  const reviews = decisions.filter((d) => d.kind !== 'approval');
  const snooze = async (key: string, days: number, remind: boolean) => {
    const d = new Date(); d.setDate(d.getDate() + days); d.setHours(9, 0, 0, 0);
    await focusApi.snooze(key, d.toISOString(), remind).catch(() => undefined);
    toastSaved(remind ? 'Напомню' : 'Отложено', d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }));
    onSnoozed();
  };
  if (!count && !decisions.length) return null;
  return (
    <section className="fp-card fp-reviews" aria-label="Проверки и решения">
      <div className="fp-head">
        <span><b>{count} {count === 1 ? 'проверка' : count < 5 ? 'проверки' : 'проверок'}</b> · ≈ {dur(minutes)}{at ? ` · в ${at}` : ''}</span>
        {reviews.length > 0 && <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => onStart(reviews)}>Начать разбор</button>}
      </div>
      {quick.length > 0 && (
        <div className="fp-quick">
          <div className="fp-head"><span className="dim fp-small">Быстрые дела до 5 минут</span>
            <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => onStart(quick)}>Сделать подряд</button></div>
          {quick.slice(0, 6).map((q) => (
            <div key={q.key} className="fp-quick-row">
              <span>{q.title}</span>
              <DropdownMenu align="end" trigger={<button type="button" className="ui-btn ui-btn-ghost ui-btn-sm">Отложить…</button>}>
                <MenuItem onSelect={() => void snooze(q.key, 1, false)}>Отложить до завтра</MenuItem>
                <MenuItem onSelect={() => void snooze(q.key, 3, false)}>Отложить на 3 дня</MenuItem>
                <MenuItem onSelect={() => void snooze(q.key, 1, true)}>Напомнить завтра в 9:00</MenuItem>
              </DropdownMenu>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
