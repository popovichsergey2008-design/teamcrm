import { useCallback, useEffect, useRef, useState } from 'react';
import './focus-zen.css';
import { Icon } from './Icon';
import { Button } from './ui/button';
import { api, ApiError, FocusSession } from '../lib/api';
import { focusSoundOn, playFocusDone, setFocusSound } from '../lib/sound';
import { refreshFocusSession, remainingNow, setFocusSession, useFocusSession } from '../hooks/useFocusSession';
import { useEscape } from '../hooks/useEscape';

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

  useEscape(() => setMini(true), !mini && !ended);

  useEffect(() => { setEnded(session.finished); }, [session.finished]);

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
    playFocusDone();
  }, []);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr('');
    try { await fn(); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось — попробуйте ещё раз'); } finally { setBusy(false); }
  };

  const toggleCheck = (c: Check) => act(async () => {
    setChecks((list) => list.map((x) => (x.id === c.id ? { ...x, is_done: !x.is_done } : x)));
    await api.patchChecklist(task!.id, c.id, { isDone: !c.is_done });
  });

  /** Завершить с одним из исходов из ТЗ (п. 58) и, если просили, перенести заметки в задачу. */
  const finish = (next: 'done' | 'again' | 'break' | 'back' | 'cancel') => act(async () => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    await api.focusFinish(session.id, next === 'cancel' ? 'cancelled' : 'completed', next === 'break');
    const text = notes.trim();
    if (task && toTask && text && next !== 'cancel') {
      await api.addComment(task.id, `Заметки из глубокого фокуса:\n${text}`).catch(() => undefined);
    }
    setFocusSession(null);
    if (next === 'again') {
      setFocusSession(await api.focusStart({ taskId: task?.id ?? null, itemId: session.itemId }));
    }
    if (next === 'done' && task) onOpenTask(task.projectId, task.id);
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
            {task?.description && (
              <details className="zen-dod">
                <summary>Что нужно сделать</summary>
                <p>{task.description.slice(0, 900)}{task.description.length > 900 ? '…' : ''}</p>
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
