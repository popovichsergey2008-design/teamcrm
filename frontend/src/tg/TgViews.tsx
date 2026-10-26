import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../lib/api';
import { Icon } from '../components/Icon';
import { backButton, haptic, mainButton, openOutside, closeApp, type TgWebApp } from './telegram';
import { GateError, type TgBoard, type TgCard, type TgCheck, type TgGate, type TgSource, type TgTaskView as TaskData } from './source';

/** Описание в CRM — текст с разметкой картинок; в шторке картинки не показываем, только отмечаем. */
const plainDescription = (s: string) => s.replace(/!\[[^\]]*\]\([^)]*\)/g, '[картинка]').trim();

const errText = (e: unknown, fallback: string) =>
  e instanceof ApiError || e instanceof Error ? e.message || fallback : fallback;

/** Главная кнопка Telegram: в CRM — «Открыть в QEVO полностью», в примере — «Создать пространство». */
function useMainButton(wa: TgWebApp | null, demo: boolean, fullPath: string | null) {
  useEffect(() => {
    if (demo) return mainButton(wa, 'Создать своё пространство', () => closeApp(wa));
    if (!fullPath) return undefined;
    return mainButton(wa, 'Открыть в QEVO полностью', () => openOutside(wa, `${window.location.origin}${fullPath}`));
  }, [wa, demo, fullPath]);
}

function CardMeta({ card }: { card: TgCard }) {
  return (
    <span className="tg-meta">
      {card.assignee && <span><Icon name="user" size={13} /> {card.assignee}</span>}
      {card.due && <span className={card.overdue ? 'tg-overdue' : undefined}><Icon name="calendar" size={13} /> {card.due}</span>}
      {card.checkTotal > 0 && <span><Icon name="check-circle" size={13} /> {card.checkDone}/{card.checkTotal}</span>}
    </span>
  );
}

// ── доска ───────────────────────────────────────────────────────────────────

export function TgBoardView({ wa, source, projectId, banner, onOpen, onProject }: {
  wa: TgWebApp | null;
  source: TgSource;
  projectId: string | null;
  banner: ReactNode;
  onOpen: (taskId: string) => void;
  onProject: (projectId: string) => void;
}) {
  const [board, setBoard] = useState<TgBoard | null | undefined>(undefined);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    setErr('');
    source.board(projectId).then(setBoard).catch((e) => { setErr(errText(e, 'Не удалось загрузить доску')); setBoard(null); });
  }, [source, projectId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { source.projects().then(setProjects).catch(() => undefined); }, [source]);
  useEffect(() => backButton(wa, null), [wa]);
  useMainButton(wa, source.demo, board ? `/projects/${board.project.id}` : null);

  return (
    <>
      <header className="tg-head">
        <Icon name="board" size={18} />
        {projects.length > 1 && board ? (
          <label className="tg-project">
            <span className="tg-sr">Проект</span>
            <select value={board.project.id} onChange={(e) => onProject(e.target.value)}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <Icon name="chevron-down" size={16} />
          </label>
        ) : (
          <h1 className="tg-head-title">{board?.project.name ?? 'Доска'}</h1>
        )}
      </header>
      {banner}
      {err && (
        <div className="tg-error" role="alert">
          {err}
          <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" onClick={load}>Повторить</button>
        </div>
      )}
      {board === undefined && <div className="tg-center tg-pad"><div className="spinner" /></div>}
      {board === null && !err && (
        <p className="tg-dim tg-pad">Проектов пока нет. Создайте первый в QEVO — доска появится здесь.</p>
      )}
      {board && (
        <div className="tg-board" aria-label={`Доска «${board.project.name}»`}>
          {board.columns.map((c) => (
            <section key={c.id} className="tg-col" aria-label={c.name}>
              <h2 className="tg-col-title">{c.name} <span className="tg-count">{c.cards.length}</span></h2>
              {c.cards.length === 0 && <p className="tg-dim tg-empty">Пусто</p>}
              {c.cards.map((t) => (
                <button key={t.id} type="button" className="tg-card" onClick={() => { haptic(wa, 'tap'); onOpen(t.id); }}>
                  <span className="tg-card-title">{t.title}</span>
                  <CardMeta card={t} />
                </button>
              ))}
            </section>
          ))}
        </div>
      )}
    </>
  );
}

// ── карточка задачи ─────────────────────────────────────────────────────────

export function TgTaskView({ wa, source, taskId, banner, onBack }: {
  wa: TgWebApp | null;
  source: TgSource;
  taskId: string;
  banner: ReactNode;
  onBack: (projectId: string) => void;
}) {
  const [task, setTask] = useState<TaskData | null | undefined>(undefined);
  const [items, setItems] = useState<TgCheck[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [gate, setGate] = useState<{ gate: TgGate; columnId: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, list] = await Promise.all([source.task(taskId), source.checklist(taskId)]);
      setTask(t); setItems(list);
    } catch (e) {
      setErr(errText(e, 'Не удалось открыть задачу'));
      setTask((prev) => prev ?? null);
    }
  }, [source, taskId]);

  useEffect(() => { void load(); }, [load]);
  // «Назад» Telegram: обработчик один на всё время карточки, иначе кнопка мигает на каждой отрисовке
  const back = useRef(() => onBack(''));
  back.current = () => onBack(task?.projectId ?? '');
  useEffect(() => backButton(wa, () => back.current()), [wa]);
  useMainButton(wa, source.demo, task ? `/projects/${task.projectId}/task/${taskId}` : null);

  const toggle = async (it: TgCheck) => {
    const done = !it.done;
    setItems((xs) => xs.map((x) => (x.id === it.id ? { ...x, done } : x)));
    haptic(wa, done ? 'success' : 'tap');
    try {
      await source.toggle(taskId, it.id, done);
    } catch (e) {
      setItems((xs) => xs.map((x) => (x.id === it.id ? { ...x, done: it.done } : x)));
      setErr(errText(e, 'Не удалось отметить пункт'));
    }
  };

  const move = async (columnId: string, force = false) => {
    if (!task || busy || (columnId === task.columnId && !force)) return;
    setErr(''); setBusy(true);
    try {
      await source.move(taskId, columnId, force);
      setGate(null);
      haptic(wa, 'success');
      await load();
    } catch (e) {
      if (e instanceof GateError) setGate({ gate: e.gate, columnId });
      else { setErr(errText(e, 'Не удалось сменить статус')); haptic(wa, 'error'); }
    } finally {
      setBusy(false);
    }
  };

  if (task === undefined) return <div className="tg-center tg-pad"><div className="spinner" /></div>;
  if (task === null) {
    return (
      <div className="tg-pad">
        {banner}
        <div className="tg-error" role="alert">{err || 'Задача не найдена'}</div>
        <button type="button" className="ui-btn ui-btn-outline ui-btn-md" onClick={() => onBack('')}>
          <Icon name="arrow-left" size={16} /> К доске
        </button>
      </div>
    );
  }

  const done = items.filter((i) => i.done).length;
  return (
    <article className="tg-task">
      {banner}
      <p className="tg-dim tg-crumb">{task.projectName}</p>
      <h1 className="tg-title">{task.card.title}</h1>

      <dl className="tg-fields">
        <div><dt>Исполнитель</dt><dd>{task.card.assignee ?? 'не назначен'}</dd></div>
        <div><dt>Срок</dt><dd className={task.card.overdue ? 'tg-overdue' : undefined}>{task.card.due ?? 'без срока'}</dd></div>
      </dl>

      <section className="tg-section" aria-labelledby="tg-status">
        <h2 id="tg-status" className="tg-h2">Статус</h2>
        <div className="tg-status" role="radiogroup" aria-label="Статус задачи">
          {task.columns.map((c) => (
            <button
              key={c.id} type="button" role="radio" aria-checked={c.id === task.columnId}
              className={`tg-chip${c.id === task.columnId ? ' is-on' : ''}`}
              disabled={busy} onClick={() => void move(c.id)}
            >
              {c.id === task.columnId && <Icon name="check" size={14} />} {c.name}
            </button>
          ))}
        </div>
        {gate && (
          <div className="tg-gate" role="alert">
            <b>{gate.gate.locked ? 'Задачу нельзя сдать' : 'Работа сдаётся не полностью'}</b>
            <p className="tg-dim">Задача уходит в «{gate.gate.column}». Не хватает:</p>
            <ul>{gate.gate.missing.map((m) => <li key={m}>{m}</li>)}</ul>
            <div className="tg-actions">
              <button type="button" className="ui-btn ui-btn-outline ui-btn-md" onClick={() => setGate(null)}>
                {gate.gate.locked ? 'Вернуться к чек-листу' : 'Вернуться и дополнить'}
              </button>
              {!gate.gate.locked && (
                <button type="button" className="ui-btn ui-btn-primary ui-btn-md" disabled={busy} onClick={() => void move(gate.columnId, true)}>
                  Сдать всё равно
                </button>
              )}
            </div>
          </div>
        )}
      </section>

      {err && <div className="tg-error" role="alert">{err}</div>}

      <section className="tg-section" aria-labelledby="tg-check">
        <h2 id="tg-check" className="tg-h2">Чек-лист {items.length > 0 && <span className="tg-count">{done}/{items.length}</span>}</h2>
        {items.length > 0 && (
          <div className="tg-progress" aria-hidden="true"><span style={{ width: `${Math.round((done / items.length) * 100)}%` }} /></div>
        )}
        {items.length === 0 && <p className="tg-dim">Пунктов нет.</p>}
        <ul className="tg-checklist">
          {items.map((it) => (
            <li key={it.id}>
              <label className={`tg-check${it.done ? ' is-done' : ''}`}>
                <input type="checkbox" checked={it.done} onChange={() => void toggle(it)} />
                <span>{it.text}</span>
              </label>
            </li>
          ))}
        </ul>
      </section>

      {task.description && (
        <details className="tg-desc">
          <summary>Описание</summary>
          <p>{plainDescription(task.description)}</p>
        </details>
      )}
    </article>
  );
}
