import { useCallback, useEffect, useRef, useState } from 'react';
import './focus-zen.css';
import { Icon } from './Icon';
import { Button } from './ui/button';
import { api, ApiError, FocusSession, type FocusSummary } from '../lib/api';
import { navigate } from '../lib/router';
import { focusSoundOn, setFocusSound } from '../lib/sound';
import { readFocusMinutes, refreshFocusSession, remainingNow, setFocusSession, takeMissedCalls, useFocusSession } from '../hooks/useFocusSession';
import { useEscape } from '../hooks/useEscape';
import { feedback } from '../lib/feedback';
import { Linkify } from './Linkify';

/**
 * Окно глубокой работы (ТЗ-16, п. 49): таймер, задача, что считать готовым,
 * чек-лист, быстрые заметки, пауза и стоп — и ничего больше. Меню, чаты и задачи
 * закрыты этим окном; свернуть можно в плашку, тишина при этом остаётся.
 */

const fmt = (sec: number) => {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

/**
 * Таймер — отдельным компонентом: раз в секунду перерисовывается только он, а не
 * всё окно (п. 117). Время — от сервера, с поправкой на прошедшее с ответа.
 */
function FocusTimer({ session, receivedAt, onElapsed, small }: {
  session: FocusSession; receivedAt: number; onElapsed: () => void; small?: boolean;
}) {
  const [left, setLeft] = useState(() => remainingNow(session, receivedAt));
  const fired = useRef(false);
  useEffect(() => {
    fired.current = false;
    const tick = () => {
      const v = remainingNow(session, receivedAt);
      setLeft(v);
      if (v <= 0 && !fired.current && session.status === 'running') { fired.current = true; onElapsed(); }
    };
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, [session, receivedAt, onElapsed]);
  const total = session.plannedMinutes * 60;
  const pct = Math.min(100, Math.max(0, ((total - left) / total) * 100));
  if (small) return <span className="zen-pill-time">{fmt(left)}</span>;
  return (
    <div className="zen-timer" role="timer" aria-label={`Осталось ${Math.ceil(left / 60)} мин`}>
      <span className="zen-time">{fmt(left)}</span>
      <div className="zen-bar"><span style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

type Check = { id: string; text: string; is_done: boolean };

export function FocusZen({ session, onOpenTask }: {
  session: FocusSession;
  onOpenTask: (projectId: string, taskId: string) => void;
}) {
  const { receivedAt } = useFocusSession();
  const [mini, setMini] = useState(false);
  const [ended, setEnded] = useState(session.finished);
  const [early, setEarly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [notes, setNotes] = useState(session.notes);
  const [toTask, setToTask] = useState(true);
  const [checks, setChecks] = useState<Check[]>([]);
  const [sound, setSound] = useState(focusSoundOn());
  const saveTimer = useRef<number | null>(null);
  const task = session.task;
  /** #4787, п. 13: сводка «пока вы были заняты» и «как продвинулась работа» по задачам. */
  const [summary, setSummary] = useState<FocusSummary | null>(null);
  const [missed, setMissed] = useState<{ name: string; at: number }[]>([]);
  const [results, setResults] = useState<Record<string, 'done' | 'later' | 'more'>>({});
  const [later, setLater] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const focusTasks = session.tasks?.length ? session.tasks : task ? [{ id: task.id, title: task.title, projectId: task.projectId }] : [];

  useEscape(() => setMini(true), !mini && !ended);

  useEffect(() => { setEnded(session.finished); }, [session.finished]);
  useEffect(() => {
    if (!ended && !early) return;
    api.focusSummary(session.id).then(setSummary).catch(() => setSummary(null));
    setMissed((m) => [...m, ...takeMissedCalls(Date.parse(session.startedAt))]);
  }, [ended, early, session.id, session.startedAt]);

  useEffect(() => {
    if (!task) return;
    api.listChecklist(task.id).then((r) => setChecks(r as Check[])).catch(() => setChecks([]));
  }, [task]);

  // Заметки сохраняем на ходу: закрыл вкладку — заметка не пропала.
  const onNotes = (v: string) => {
    setNotes(v);
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { void api.focusNotes(session.id, v).catch(() => undefined); }, 700);
  };

  const elapsed = useCallback(() => {
    setEnded(true);
    setMini(false);
    feedback('focus.completed');
  }, []);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr('');
    try { await fn(); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось — попробуйте ещё раз'); } finally { setBusy(false); }
  };

  const toggleCheck = (c: Check) => act(async () => {
    if (!c.is_done) feedback('task.checked');
    setChecks((list) => list.map((x) => (x.id === c.id ? { ...x, is_done: !x.is_done } : x)));
    await api.patchChecklist(task!.id, c.id, { isDone: !c.is_done });
  });

  /** Завершить с одним из исходов из ТЗ (п. 58) и, если просили, перенести заметки в задачу. */
  const finish = (next: 'done' | 'again' | 'break' | 'back' | 'cancel') => act(async () => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    // «как продвинулась работа» — до завершения; таймер сам задачи не закрывает
    const picked = Object.entries(results).map(([taskId, result]) => ({ taskId, result }));
    if (picked.length && next !== 'cancel') await api.focusOutcomes(session.id, picked).catch(() => undefined);
    await api.focusFinish(session.id, next === 'cancel' ? 'cancelled' : 'completed', next === 'break');
    const text = notes.trim();
    if (task && toTask && text && next !== 'cancel') {
      await api.addComment(task.id, `Заметки из глубокого фокуса:\n${text}`).catch(() => undefined);
    }
    setFocusSession(null);
    if (next === 'again') {
      // «ещё раз» — той же длительности, что человек выбрал (#1568)
      setFocusSession(await api.focusStart({ taskId: task?.id ?? null, itemId: session.itemId, minutes: readFocusMinutes() }));
      feedback('focus.started');
    }
    if (next === 'done' && task) onOpenTask(task.projectId, task.id);
    // «Задача выполнена» — в её карточку: сдаётся обычным путём, с проверками приёмки
    const doneTask = focusTasks.find((t) => results[t.id] === 'done');
    const moreTask = focusTasks.find((t) => results[t.id] === 'more');
    if (next !== 'done' && next !== 'cancel' && doneTask) onOpenTask(doneTask.projectId, doneTask.id);
    // «Нужно ещё время» — в календарь, к подбору времени для этой задачи
    else if (next !== 'cancel' && moreTask) {
      try { sessionStorage.setItem('calendar.planTask', moreTask.id); } catch { /* без хранилища — просто календарь */ }
      navigate({ section: 'calendar' });
    }
    void refreshFocusSession();
  });

  if (mini && !ended) {
    return (
      <button type="button" className="zen-pill" onClick={() => setMini(false)} aria-label="Развернуть глубокий фокус">
        <span className="zen-dot" aria-hidden="true" />
        <FocusTimer session={session} receivedAt={receivedAt} onElapsed={elapsed} small />
        <span className="zen-pill-label">{session.status === 'paused' ? 'Пауза' : 'Глубокий фокус'}</span>
      </button>
    );
  }

  const doneCount = checks.filter((c) => c.is_done).length;

  return (
    <div className="zen" role="dialog" aria-modal="true" aria-label="Глубокий фокус">
      <div className="zen-top">
        <span className="zen-badge"><span className="zen-dot" aria-hidden="true" /> Глубокий фокус · сообщения приходят без звука</span>
        <span className="zen-top-acts">
          <Button
            variant="ghost" size="sm" aria-pressed={sound}
            title={sound ? 'Сигнал в конце включён' : 'Сигнал в конце выключен'}
            onClick={() => { setFocusSound(!sound); setSound(!sound); }}
          ><Icon name={sound ? 'volume' : 'bell'} size={15} /> {sound ? 'Со звуком' : 'Без звука'}</Button>
          {!ended && <Button variant="ghost" size="sm" onClick={() => setMini(true)}><Icon name="minimize" size={15} /> Свернуть</Button>}
        </span>
      </div>

      <div className="zen-body">
        {ended || early ? (
          <section className="zen-end" aria-live="polite">
            <h2><Icon name="check-circle" size={22} /> {early ? 'Закончить фокус?' : 'Фокус завершён'}</h2>
            {summary && <p className="zen-worked">Вы работали {summary.minutes} мин.</p>}
            {summary && !later && (summary.items.length > 0 || missed.length > 0) && (
              <div className="zen-summary">
                <div className="zen-sub">Пока вы были заняты:</div>
                <ul>
                  {[...missed.map((c) => ({ kind: 'call', text: `${c.name} звонил(а) — звонок не прерывал фокус`, link: null })), ...summary.items]
                    .slice(0, showAll ? 50 : 4)
                    .map((it, i) => (
                      <li key={i}>
                        {it.link ? (
                          <button type="button" className="zen-sum-link" onClick={() => {
                            setMini(true);
                            const l = it.link!;
                            if (l.section === 'projects' && l.projectId && l.taskId) onOpenTask(l.projectId, l.taskId);
                            else navigate(l.section === 'chat' ? { section: 'chat', chatId: l.chatId } : { section: l.section as 'calendar' });
                          }}>— {it.text}</button>
                        ) : <span>— {it.text}</span>}
                      </li>
                    ))}
                </ul>
                <div className="zen-end-acts">
                  {missed.length + summary.items.length > 4 && !showAll && <Button size="sm" variant="outline" onClick={() => setShowAll(true)}>Посмотреть</Button>}
                  <Button size="sm" variant="ghost" onClick={() => setLater(true)}>Разобрать позже</Button>
                </div>
              </div>
            )}
            {summary && summary.items.length === 0 && missed.length === 0 && <p className="zen-worked dim">Пока вы были заняты, ничего не произошло.</p>}
            {focusTasks.length > 0 && (
              <div className="zen-outcomes">
                <div className="zen-sub">Как продвинулась работа?</div>
                {focusTasks.map((t) => (
                  <div key={t.id} className="zen-outcome">
                    <span className="zen-outcome-title">№{t.id} {t.title}</span>
                    <span className="kv2-seg" role="group" aria-label={`Итог по задаче №${t.id}`}>
                      {([['done', 'Задача выполнена'], ['later', 'Продолжить позже'], ['more', 'Нужно ещё время']] as const).map(([k, label]) => (
                        <button key={k} type="button" className="kv2-seg-btn" aria-pressed={results[t.id] === k}
                          onClick={() => setResults((r) => ({ ...r, [t.id]: k }))}>{label}</button>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {task && notes.trim() && (
              <label className="zen-tonote">
                <input type="checkbox" checked={toTask} onChange={(e) => setToTask(e.target.checked)} />
                Добавить заметки в задачу
              </label>
            )}
            <div className="zen-end-acts">
              {task && <Button variant="primary" disabled={busy} onClick={() => void finish('done')}><Icon name="check" size={15} /> Задача готова</Button>}
              <Button variant="outline" disabled={busy} onClick={() => void finish('again')}><Icon name="refresh" size={15} /> Нужен ещё один фокус</Button>
              <Button variant="outline" disabled={busy} onClick={() => void finish('break')}><Icon name="clock" size={15} /> Перерыв 10 минут</Button>
              <Button variant="ghost" disabled={busy} onClick={() => void finish('back')}>Вернуться к работе</Button>
              {early && <Button variant="ghost" disabled={busy} onClick={() => setEarly(false)}>Продолжить фокус</Button>}
            </div>
            {err && <div className="error-text" role="alert">{err}</div>}
          </section>
        ) : (
          <>
            <FocusTimer session={session} receivedAt={receivedAt} onElapsed={elapsed} />
            {task ? (
              <button type="button" className="zen-task" onClick={() => { setMini(true); onOpenTask(task.projectId, task.id); }}>
                {task.title}
              </button>
            ) : <div className="zen-task zen-task-free">Работа без отвлечений</div>}
            {(session.tasks?.length ?? 0) > 1 && (
              <div className="zen-more-tasks">
                Ещё в этом фокусе:{' '}
                {session.tasks!.slice(1).map((t, i) => (
                  <button key={t.id} type="button" className="zen-sum-link" onClick={() => { setMini(true); onOpenTask(t.projectId, t.id); }}>
                    {i ? ', ' : ''}№{t.id} {t.title}
                  </button>
                ))}
              </div>
            )}
            {task?.description && (
              <details className="zen-dod">
                <summary>Что нужно сделать</summary>
                <p><Linkify text={task.description} /></p>
              </details>
            )}
            {checks.length > 0 && (
              <section className="zen-checks" aria-label="Чек-лист">
                <div className="zen-sub">Чек-лист · {doneCount} из {checks.length}</div>
                {checks.map((c) => (
                  <label key={c.id} className={`zen-check${c.is_done ? ' done' : ''}`}>
                    <input type="checkbox" checked={c.is_done} disabled={busy} onChange={() => void toggleCheck(c)} />
                    <span>{c.text}</span>
                  </label>
                ))}
              </section>
            )}
            <label className="zen-notes">
              <span className="zen-sub">Быстрые заметки</span>
              <textarea className="input" rows={3} value={notes} onChange={(e) => onNotes(e.target.value)} placeholder="Мысль, которую нельзя потерять, — и дальше работать" />
            </label>
            <div className="zen-acts">
              {session.status === 'running'
                ? <Button variant="outline" disabled={busy} onClick={() => void act(async () => setFocusSession(await api.focusPause(session.id)))}><Icon name="pause" size={15} /> Пауза</Button>
                : <Button variant="primary" disabled={busy} onClick={() => void act(async () => setFocusSession(await api.focusResume(session.id)))}><Icon name="play" size={15} /> Продолжить</Button>}
              <Button variant="ghost" disabled={busy} onClick={() => setEarly(true)}><Icon name="stop" size={15} /> Завершить</Button>
              <Button variant="ghost" disabled={busy} onClick={() => void finish('cancel')}>Отменить фокус</Button>
            </div>
            {err && <div className="error-text" role="alert">{err}</div>}
          </>
        )}
      </div>
    </div>
  );
}
