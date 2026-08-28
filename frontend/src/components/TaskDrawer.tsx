import { useEffect, useState } from 'react';
import { EmptyState } from './EmptyState';
import { Icon } from './Icon';
import { GateBlock, HandoffGateDialog, gateFromError } from './HandoffGateDialog';
import { api, ApiError } from '../lib/api';
import type { Task, User } from '../types';
import { Lightbox } from './Lightbox';
import { DatePicker } from './DatePicker';
import { MONETIZATION_ENABLED } from '../config';
import { labelTextColor } from '../lib/labels';

interface Props {
  task: Task;
  users: User[];
  columns?: { id: string; name: string }[];
  canManage?: boolean;
  timerActive: boolean;
  onToggleTimer: (taskId: string) => void;
  onClose: () => void;
  onRefresh: () => void;
}

type Tab = 'overview' | 'checklist' | 'files' | 'discussion' | 'agent';
const PRIORITIES = [['low', 'низкий'], ['normal', 'обычный'], ['high', 'высокий'], ['urgent', 'срочно']];

/** Колонки, означающие закрытие задачи (совпадает с логикой закрытия на бэкенде). */
const DONE_RE = /^(done|готово|выполнено|завершено|завершён|завершен|закрыто|сделано)$/i;
const NEAR_DONE_RE = /(тест|провер|ревью|review|сдан|приём|приемк)/i;

/**
 * Порядок колонок в выборе: при завершении вперёд идут финальные, при возврате в работу —
 * наоборот, рабочие. Подсвечиваем те, что уместнее в текущем действии.
 */
function orderColumns(columns: { id: string; name: string }[], mode: 'finish' | 'reopen') {
  const rank = (name: string) => (DONE_RE.test(name.trim()) ? 0 : NEAR_DONE_RE.test(name) ? 1 : 2);
  return columns
    .map((c) => {
      const r = rank(c.name);
      return { ...c, rank: r, highlight: mode === 'finish' ? r === 0 : r === 2 };
    })
    .sort((a, b) => (mode === 'finish' ? a.rank - b.rank : b.rank - a.rank));
}

export function TaskDrawer({ task, users, columns = [], canManage, timerActive, onToggleTimer, onClose, onRefresh }: Props) {
  const [tab, setTab] = useState<Tab>('overview');
  const [assigneeId, setAssigneeId] = useState(task.assignee_id ?? '');
  const [estimate, setEstimate] = useState(task.estimate_hours ?? '');
  // формат поля — локальное время; toISOString здесь давал сдвиг на часовой пояс и показывал чужой час
  const [deadline, setDeadline] = useState(() => {
    if (!task.deadline_at) return '';
    const d = new Date(task.deadline_at);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  });
  const [warn, setWarn] = useState<any>(null);
  const [err, setErr] = useState('');
  const [desc, setDesc] = useState(task.description ?? '');
  const [priority, setPriority] = useState(task.priority ?? 'normal');
  const [managerId, setManagerId] = useState(task.created_by ?? '');

  const userName = (id?: string | null) => users.find((u) => u.id === id)?.fullName ?? '—';
  const changeManager = async (id: string) => {
    setManagerId(id);
    await api.updateTask(task.id, { managerId: id || null });
    onRefresh();
  };

  const assign = async (confirmOverload: boolean) => {
    if (!assigneeId) return setErr('Выберите исполнителя');
    setErr('');
    try {
      const res = await api.assignTask(task.id, {
        assigneeId, confirmOverload,
        estimateHours: estimate ? Number(estimate) : undefined,
        deadlineAt: deadline ? new Date(deadline).toISOString() : undefined,
      });
      if (res.warning && !confirmOverload) setWarn(res);
      else { setWarn(null); onRefresh(); }
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Ошибка'); }
  };
  const saveDesc = async () => { await api.updateTask(task.id, { description: desc }); onRefresh(); };
  const changePriority = async (p: string) => { setPriority(p); await api.updateTask(task.id, { priority: p }); onRefresh(); };
  const toggleBlocked = async () => { await api.updateTask(task.id, { isBlocked: !task.is_blocked }); onRefresh(); };
  // сменить статус = переместить в колонку доски (наверх колонки)
  const [moving, setMoving] = useState(false);
  // приёмка работы: сдаём не полностью — сначала показываем, чего не хватает
  const [gate, setGate] = useState<{ block: GateBlock; columnId: string } | null>(null);
  const moveToColumn = async (columnId: string, confirmGate = false) => {
    if (columnId === task.column_id || moving) return;
    setErr(''); setMoving(true);
    try { await api.moveTask(task.id, { columnId, position: 0, confirmGate }); setGate(null); onRefresh(); }
    catch (e) {
      const block = e instanceof ApiError ? gateFromError(e.details) : null;
      if (block) setGate({ block, columnId });
      else setErr(e instanceof ApiError ? e.message : 'Не удалось сменить статус');
    }
    finally { setMoving(false); }
  };

  // Удаление безвозвратно и уносит комментарии с чек-листом, поэтому спрашиваем прямо.
  /**
   * Удаление. Второй вопрос задаётся только там, где он действительно нужен:
   * если по задаче учтено рабочее время, сервер отвечает отказом и говорит, сколько
   * именно. Тогда спрашиваем ещё раз — и повторяем удаление с подтверждением.
   * Часы при этом не пропадают: они остаются в себестоимости проекта.
   */
  const removeTask = async (confirmTimeLoss = false) => {
    if (!confirmTimeLoss
      && !window.confirm(`Удалить задачу «${task.title}»? Вместе с ней исчезнут комментарии, чек-лист и вложения. Отменить это будет нельзя.`)) return;
    setErr(''); setMoving(true);
    try {
      await api.deleteTask(task.id, confirmTimeLoss);
      onRefresh();
      onClose();
    } catch (e) {
      const timeLoss = e instanceof ApiError
        ? (e.details as { timeLoss?: { seconds: number; text: string } } | undefined)?.timeLoss
        : undefined;
      if (timeLoss && !confirmTimeLoss) {
        setMoving(false);
        if (window.confirm(`${e instanceof ApiError ? e.message : ''}

Удалить задачу?`)) {
          await removeTask(true);
        }
        return;
      }
      setErr(e instanceof ApiError ? e.message : 'Не удалось удалить задачу');
    } finally {
      setMoving(false);
    }
  };

  const cost = task.cost_current !== undefined ? Number(task.cost_current) : null;

  // «Завершить» = перенос в финальную колонку. Если у проекта есть «Готово» —
  // переносим сразу туда, без вопросов: в 99% случаев ответ именно такой, а
  // лишний выбор превращал одно действие в два. Выбор колонки остался рядом,
  // под кнопкой «…», и становится основным там, где «Готово» нет: у импортных
  // досок финальная колонка называется по-своему («Сдано», «На тестировании»),
  // и угадывать за человека мы не будем.
  // Возврат в работу выбор сохраняет: рабочих колонок много и очевидной среди них нет.
  const [choosing, setChoosing] = useState(false);
  const isDone = !!task.closed_at;
  const targets = orderColumns(columns, isDone ? 'reopen' : 'finish').filter((c) => c.id !== task.column_id);
  const doneTarget = isDone ? null : targets.find((c) => DONE_RE.test(c.name.trim())) ?? null;

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer drawer-wide" onClick={(e) => e.stopPropagation()}>
        {gate && (
          <HandoffGateDialog
            block={gate.block}
            busy={moving}
            onCancel={() => setGate(null)}
            onForce={() => moveToColumn(gate.columnId, true)}
          />
        )}
        <div className="drawer-head">
          <h3>
            {task.title}
            {/* Номер нужен человеку, а не системе: по нему задачу называют боту
                в ежедневном отчёте и в переписке. Клик копирует — переписывать
                цифры с экрана руками никто не должен. */}
            <button
              className="task-num"
              onClick={() => navigator.clipboard?.writeText(`#${task.id}`).catch(() => undefined)}
              title="Номер задачи — скопировать. По нему задачу называют боту в отчёте"
            >
              #{task.id}
            </button>
          </h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose} title="Закрыть"><Icon name="close" /></button>
        </div>

        {/* Завершение — отдельной строкой под заголовком. Сбоку от названия кнопка
            жалась к «закрыть» и терялась тем сильнее, чем длиннее название задачи. */}
        {(isDone || targets.length > 0 || canManage) && (
          <div className="task-actions-row">
            {targets.length > 0 && (
              <div className="finish-group">
                <button
                  className={`btn btn-sm ${isDone ? 'btn-reopen' : 'btn-finish'}`}
                  onClick={() => (doneTarget ? moveToColumn(doneTarget.id) : setChoosing((v) => !v))}
                  disabled={moving}
                  title={
                    isDone ? 'Снять завершение и вернуть задачу в работу'
                      : doneTarget ? `Завершить и перенести в «${doneTarget.name}»`
                        : 'Перенести задачу в финальную колонку'
                  }
                >
                  {isDone ? <><Icon name="reply" size={14} /> Вернуть в работу</> : <><Icon name="check" size={14} /> Завершить</>}
                </button>
                {doneTarget && (
                  <button
                    className="btn btn-sm finish-more"
                    onClick={() => setChoosing((v) => !v)}
                    disabled={moving}
                    title="Завершить, но перенести в другую колонку"
                    aria-label="Выбрать колонку"
                  >
                    <Icon name="more" size={14} />
                  </button>
                )}
              </div>
            )}
            {isDone && <span className="badge badge-ok" title="Задача закрыта"><Icon name="check" size={12} /> завершена</span>}
            {canManage && (
              <button className="btn btn-ghost btn-sm btn-delete" onClick={() => removeTask()} disabled={moving} title="Удалить задачу без возможности восстановления">
                <Icon name="trash" size={14} /> Удалить
              </button>
            )}
          </div>
        )}

        {choosing && (
          <div className={`finish-picker ${isDone ? 'reopen-picker' : ''}`}>
            <span className="status-label">{isDone ? 'Вернуть в колонку' : 'Куда перенести задачу?'}</span>
            <div className="status-pills">
              {targets.map((c) => (
                <button
                  key={c.id}
                  className={`status-pill ${c.highlight ? (isDone ? 'pill-work' : 'pill-final') : ''}`}
                  disabled={moving}
                  onClick={async () => { await moveToColumn(c.id); setChoosing(false); }}
                >
                  {c.highlight && !isDone && <Icon name="check" size={12} />}{c.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {columns.length > 0 && (
          <div className="status-bar">
            <span className="status-label">Статус</span>
            <div className="status-pills">
              {columns.map((c) => (
                <button
                  key={c.id}
                  className={`status-pill ${c.id === task.column_id ? 'active' : ''}`}
                  onClick={() => moveToColumn(c.id)}
                  disabled={moving}
                  title={c.id === task.column_id ? 'Текущая колонка' : `Переместить в «${c.name}»`}
                >
                  {c.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="drawer-row card-meta">
          {task.agent_assigned && <span className="badge badge-info" title="Исполнитель — ИИ-агент"><Icon name="robot" size={12} /> ИИ-агент</span>}
          <select className="input prio-select" value={priority} onChange={(e) => changePriority(e.target.value)}>
            {PRIORITIES.map(([v, l]) => <option key={v} value={v}>приоритет: {l}</option>)}
          </select>
          {task.risk_level && <span className={`badge risk-badge risk-${task.risk_level}`} title="Риск срыва срока"><Icon name="alert" size={12} /> {task.risk_pct ?? '—'}%</span>}
          {MONETIZATION_ENABLED && cost !== null && <span className="badge">₽ {cost.toLocaleString('ru-RU')}</span>}
          <button className={`btn btn-ghost btn-sm ${task.is_blocked ? 'blocked-on' : ''}`} onClick={toggleBlocked} title="Блокировка задачи">
            {task.is_blocked ? <><Icon name="alert" size={14} /> BLOCKED</> : 'Отметить BLOCKED'}
          </button>
        </div>
        {err && <div className="error-text">{err}</div>}
        <LabelsRow task={task} onRefresh={onRefresh} />

        <div className="tabs">
          <button className={`tab ${tab === 'overview' ? 'active' : ''}`} onClick={() => setTab('overview')}>Обзор</button>
          <button className={`tab ${tab === 'checklist' ? 'active' : ''}`} onClick={() => setTab('checklist')}>Чеклист</button>
          <button className={`tab ${tab === 'files' ? 'active' : ''}`} onClick={() => setTab('files')}>Файлы</button>
          <button className={`tab ${tab === 'discussion' ? 'active' : ''}`} onClick={() => setTab('discussion')}>Обсуждение</button>
          {canManage && <button className={`tab ${tab === 'agent' ? 'active' : ''}`} onClick={() => setTab('agent')}><Icon name="robot" size={14} /> Агент</button>}
        </div>

        {tab === 'agent' && canManage && <AgentTab taskId={task.id} assigned={!!task.agent_assigned} onRefresh={onRefresh} />}

        {tab === 'overview' && (
          <>
            {/* Обе кнопки на виду: одна кнопка-переключатель не показывала, в каком
                состоянии таймер сейчас, и «Пауза» читалась как «идёт пауза». */}
            <div className={`timer-panel ${timerActive ? 'is-running' : ''}`}>
              <div className="timer-state">
                <span className="timer-dot" />
                <span>{timerActive ? 'Идёт работа' : 'Таймер остановлен'}</span>
              </div>
              <div className="timer-actions">
                <button
                  className="btn btn-sm timer-go"
                  disabled={timerActive}
                  title={timerActive ? 'Таймер уже идёт' : 'Начать отсчёт времени по задаче'}
                  onClick={() => onToggleTimer(task.id)}
                >
                  <Icon name="play" size={13} /> В работу
                </button>
                <button
                  className="btn btn-sm timer-pause"
                  disabled={!timerActive}
                  title={timerActive ? 'Остановить отсчёт' : 'Таймер не запущен'}
                  onClick={() => onToggleTimer(task.id)}
                >
                  <Icon name="pause" size={13} /> Пауза
                </button>
              </div>
            </div>
            <div className="field"><label>Описание (Markdown)</label>
              <textarea className="input" rows={5} value={desc} onChange={(e) => setDesc(e.target.value)} />
              <button className="btn btn-sm" style={{ marginTop: 6 }} onClick={saveDesc}>Сохранить описание</button>
            </div>
            <div className="drawer-section">
              <div className="drawer-section-title">Назначение и план</div>
              <div className="drawer-grid2">
                <div className="field"><label>Исполнитель</label>
                  <select className="input" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
                    <option value="">— не назначен —</option>
                    {users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
                  </select>
                </div>
                <div className="field"><label title="Кто ставит задачу и принимает результат">Постановщик</label>
                  <select className="input" value={managerId} onChange={(e) => changeManager(e.target.value)}>
                    <option value="">— не задан —</option>
                    {users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
                  </select>
                </div>
              </div>
              <div className="drawer-grid2">
                <div className="field"><label>Оценка, ч</label><input className="input" type="number" min="0" step="0.5" value={estimate} onChange={(e) => setEstimate(e.target.value)} /></div>
                <div className="field"><label>Дедлайн</label>
                  <DatePicker value={deadline} onChange={setDeadline} withTime warnPast placeholder="срок не задан" />
                </div>
              </div>
              {warn && (
                <div className="overload-warn"><Icon name="alert" size={13} /> Перегруз: риск {warn.riskPct ?? '—'}%, {warn.projectedHours}ч &gt; {warn.capacityHours}ч/нед.
                  <button className="btn btn-sm overload-confirm" onClick={() => assign(true)}>Всё равно назначить</button>
                </div>
              )}
              <button className="btn btn-primary drawer-assign" onClick={() => assign(false)}>Назначить</button>
            </div>
            <div className="drawer-section">
              <div className="drawer-section-title">Прогноз срока</div>
              <div className="drawer-row">
                {task.risk_level && <span className={`risk-dot risk-${task.risk_level}`} />}
                <span>{task.risk_level ? `риск ${task.risk_pct ?? '—'}% (${task.risk_level})` : 'нет прогноза'}</span>
              </div>
              {task.predicted_finish_at && <div className="dim">Прогноз: {new Date(task.predicted_finish_at).toLocaleString('ru-RU')}</div>}
              <div className="dim">Исполнитель: {userName(assigneeId || null)} · Постановщик: {userName(managerId || null)}</div>
            </div>
          </>
        )}

        {tab === 'checklist' && <ChecklistTab taskId={task.id} onRefresh={onRefresh} />}
        {tab === 'files' && <FilesTab taskId={task.id} onRefresh={onRefresh} />}
        {tab === 'discussion' && <DiscussionTab taskId={task.id} onRefresh={onRefresh} />}
      </aside>
    </div>
  );
}

function LabelsRow({ task, onRefresh }: { task: Task; onRefresh: () => void }) {
  const [labels, setLabels] = useState<any[]>(task.labels ?? []);
  const [all, setAll] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const reload = () => api.taskLabels(task.id).then(setLabels).catch(() => undefined);
  useEffect(() => { if (open) api.listLabels().then(setAll).catch(() => undefined); }, [open, task.id]);
  const toggle = async (id: string, has: boolean) => {
    if (has) await api.unassignLabel(task.id, id); else await api.assignLabel(task.id, id);
    reload(); onRefresh();
  };
  return (
    <div className="labels-row">
      {labels.map((l) => <span key={l.id} className="label-chip" style={{ background: l.color, color: labelTextColor(l.color) }}>{l.name}</span>)}
      <button className="btn btn-ghost btn-sm" onClick={() => setOpen(!open)}>+ метка</button>
      {open && (
        <div className="label-pick">
          {all.length === 0 && <span className="dim">Меток пока нет — создайте первую полем ниже. Метки общие для всех проектов.</span>}
          {all.map((l) => {
            const has = labels.some((x) => x.id === l.id);
            return <button key={l.id} className={`label-chip ${has ? '' : 'label-off'}`} style={{ background: has ? l.color : 'transparent', borderColor: l.color, color: has ? labelTextColor(l.color) : undefined }} onClick={() => toggle(l.id, has)}>{l.name}</button>;
          })}
          <NewLabel onCreated={() => api.listLabels().then(setAll)} />
        </div>
      )}
    </div>
  );
}
function NewLabel({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  return (
    <div className="team-rate" style={{ marginTop: 6 }}>
      <input className="input" placeholder="новая метка" value={name} onChange={(e) => setName(e.target.value)} />
      <button className="btn btn-sm" onClick={async () => { if (name.trim()) { await api.createLabel({ name: name.trim() }); setName(''); onCreated(); } }}>+</button>
    </div>
  );
}

function ChecklistTab({ taskId, onRefresh }: { taskId: string; onRefresh: () => void }) {
  const [items, setItems] = useState<any[]>([]);
  const [text, setText] = useState('');
  const reload = () => api.listChecklist(taskId).then(setItems).catch(() => undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, [taskId]);
  const done = items.filter((i) => i.is_done).length;
  return (
    <>
      {items.length > 0 && <div className="dim">{done} / {items.length} выполнено</div>}
      {items.length === 0 && (
        <EmptyState compact icon="check" title="Чек-листа нет"
          hint="Разбейте задачу на шаги — станет видно, сколько уже сделано, и работу проще передать." />
      )}
      {items.map((i) => (
        <label key={i.id} className="notify-row">
          <input type="checkbox" checked={i.is_done} onChange={async () => { await api.patchChecklist(taskId, i.id, { isDone: !i.is_done }); reload(); onRefresh(); }} />
          <span style={{ flex: 1, textDecoration: i.is_done ? 'line-through' : 'none' }}>{i.text}</span>
          <button className="btn btn-ghost btn-sm" onClick={async () => { await api.deleteChecklist(taskId, i.id); reload(); onRefresh(); }} title="Удалить"><Icon name="close" size={13} /></button>
        </label>
      ))}
      <div className="team-rate" style={{ marginTop: 10 }}>
        <input className="input" placeholder="новый пункт" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && text.trim() && (async () => { await api.addChecklist(taskId, text.trim()); setText(''); reload(); onRefresh(); })()} />
        <button className="btn btn-primary btn-sm" onClick={async () => { if (text.trim()) { await api.addChecklist(taskId, text.trim()); setText(''); reload(); onRefresh(); } }}>+</button>
      </div>
    </>
  );
}

function AgentTab({ taskId, assigned, onRefresh }: { taskId: string; assigned: boolean; onRefresh: () => void }) {
  const [runs, setRuns] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [prompts, setPrompts] = useState<any[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [promptId, setPromptId] = useState(''); // '' = по умолчанию, '__custom__' = свой, иначе id пресета
  const [customText, setCustomText] = useState('');
  const [customModel, setCustomModel] = useState('');
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 4000); };
  const reload = () => api.agentRuns(taskId).then(setRuns).catch(() => undefined);
  useEffect(() => {
    reload();
    api.agentPrompts().then(setPrompts).catch(() => undefined);
    api.agentModels().then(setModels).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  // опции запуска из выбранного промпта (пресет / свой / по умолчанию)
  const runOpts = (): { presetId?: string; instruction?: string; model?: string } | undefined => {
    if (promptId === '__custom__') return { instruction: customText.trim() || undefined, model: customModel || undefined };
    if (promptId) return { presetId: promptId };
    return undefined;
  };

  const assign = async () => {
    if (!window.confirm('Передать задачу ИИ-агенту? Он станет исполнителем и сразу выполнит её (результат — на «На тестировании»).')) return;
    setBusy(true); setMsg('');
    try {
      const r = await api.agentAssign(taskId, true, runOpts());
      flash(r.run?.declined ? 'Передано агенту, но задача требует человека (см. ниже)'
        : r.run?.movedTo ? `Передано агенту — выполнено, задача в «${r.run.movedTo}»` : 'Задача передана ИИ-агенту');
      reload(); onRefresh();
    } catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); }
    finally { setBusy(false); }
  };
  const unassign = async () => {
    setBusy(true);
    try { await api.agentUnassign(taskId); flash('Снято с агента'); onRefresh(); }
    catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); }
    finally { setBusy(false); }
  };

  const statusBadge = (s: string) => (({
    running: { label: 'выполняется', cls: 'badge-info' },
    done: { label: 'на ревью', cls: 'badge-warn' },
    accepted: { label: 'принят', cls: 'badge-ok' },
    rejected: { label: 'отклонён', cls: 'badge-muted' },
    declined: { label: 'не автоматизируется', cls: 'badge-muted' },
    failed: { label: 'ошибка', cls: 'badge-danger' },
  } as Record<string, { label: string; cls: string }>)[s] ?? { label: s, cls: 'badge-muted' });

  const run = async () => {
    setBusy(true); setMsg('');
    try { await api.agentRun(taskId); flash('Готово — черновик ниже и в обсуждении задачи'); reload(); onRefresh(); }
    catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка запуска агента'); }
    finally { setBusy(false); }
  };
  const execute = async () => {
    if (!window.confirm('Передать задачу ИИ-агенту? Он выполнит её и перенесёт в «На тестировании» на вашу проверку.')) return;
    setBusy(true); setMsg('');
    try {
      const r = await api.agentExecute(taskId, runOpts());
      flash(r.declined
        ? 'Задача требует человека — агент не может её выполнить (см. пояснение ниже)'
        : `Выполнено${r.fileName ? ' — файл во вкладке «Файлы»' : ''}${r.movedTo ? `, задача в «${r.movedTo}»` : ''}`);
      reload(); onRefresh();
    } catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка выполнения'); }
    finally { setBusy(false); }
  };
  const accept = async (id: string, toChecklist: boolean) => {
    try { const r = await api.agentAccept(id, toChecklist); flash(toChecklist ? `Принято, добавлено пунктов: ${r.addedChecklist}` : 'Результат принят'); reload(); onRefresh(); }
    catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); }
  };
  const reject = async (id: string) => {
    try { await api.agentReject(id); flash('Отклонено'); reload(); onRefresh(); }
    catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); }
  };
  const rework = async (id: string) => {
    const feedback = window.prompt('Что доработать? Агент переделает результат с учётом замечаний:');
    if (!feedback || feedback.trim().length < 2) return;
    setBusy(true); setMsg('');
    try { await api.agentRework(id, feedback.trim()); flash('Доработка готова — новый результат ниже'); reload(); onRefresh(); }
    catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка доработки'); }
    finally { setBusy(false); }
  };
  const kindLabel = (k: string) => (k === 'task_execute' ? 'выполнение' : k === 'task_rework' ? 'доработка' : 'черновик');

  return (
    <>
      <div className="add-area" style={{ marginBottom: 10 }}>
        {assigned ? (
          <div className="team-head">
            <span className="badge badge-info"><Icon name="robot" size={12} /> Исполнитель — ИИ-агент</span>
            <button className="btn btn-ghost btn-sm" onClick={unassign} disabled={busy}>Снять с агента</button>
          </div>
        ) : (
          <button className="btn btn-primary btn-sm" style={{ width: '100%' }} onClick={assign} disabled={busy}>
            <Icon name="robot" size={14} /> Передать агенту
          </button>
        )}
        <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>
          «Передать агенту» — назначить ИИ исполнителем и сразу выполнить (текстовые задачи). Задача пойдёт на «На тестировании» вам на проверку.
        </div>
      </div>
      <div className="dim" style={{ fontSize: 12 }}>
        Разовые запуски: <b>Черновик</b> — предложит план (ничего не меняет).
        <b> Выполнить</b> — готовый результат → «На тестировании». Не устроило — «Доработать» с замечаниями.
      </div>

      {/* выбор промпта: пресет из библиотеки / свой / по умолчанию */}
      <div style={{ marginTop: 8 }}>
        <select className="input" value={promptId} onChange={(e) => setPromptId(e.target.value)} title="Промпт для агента">
          <option value="">Промпт: по умолчанию</option>
          {prompts.map((p) => <option key={p.id} value={p.id}>{p.name}{p.is_shared ? ' · общий' : ''}{p.model ? ` · ${p.model}` : ''}</option>)}
          <option value="__custom__">Свой промпт…</option>
        </select>
        {promptId === '__custom__' && (
          <>
            <textarea className="input" rows={3} style={{ marginTop: 6 }} placeholder="Инструкция агенту на этот запуск: роль, тон, структура…" value={customText} onChange={(e) => setCustomText(e.target.value)} />
            <select className="input" style={{ marginTop: 6 }} value={customModel} onChange={(e) => setCustomModel(e.target.value)} title="Модель">
              <option value="">Модель по умолчанию</option>
              {models.map((m) => <option key={m} value={m}>{m}{m.endsWith(':free') ? ' — бесплатно' : ''}</option>)}
            </select>
            <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>Совет: удачный промпт сохраните в «Личный кабинет → Мои промпты», чтобы переиспользовать.</div>
          </>
        )}
      </div>
      <div className="team-rate" style={{ marginTop: 8 }}>
        <button className="btn btn-sm" style={{ flex: 1 }} onClick={run} disabled={busy}>
          {busy ? 'Агент думает…' : <><Icon name="sparkles" size={14} /> Черновик</>}
        </button>
        <button className="btn btn-primary btn-sm" style={{ flex: 1 }} onClick={execute} disabled={busy} title="Автономно выполнить задачу (текст/КП) → на тестирование">
          {busy ? 'Агент работает…' : <><Icon name="robot" size={14} /> Выполнить</>}
        </button>
      </div>
      {msg && <div className="dim" style={{ marginTop: 6 }}>{msg}</div>}
      {runs.map((r) => (
        <div key={r.id} className="team-row" style={{ marginTop: 8 }}>
          <div className="team-head">
            <span className={`badge ${statusBadge(r.status).cls}`}>{statusBadge(r.status).label}</span>
            <span className="dim" style={{ fontSize: 12 }}>
              {kindLabel(r.kind)} · {new Date(r.created_at).toLocaleString('ru-RU')}
              {(r.input_tokens || r.output_tokens) ? ` · ~${(r.input_tokens || 0) + (r.output_tokens || 0)} ток.` : ''}
            </span>
          </div>
          {r.result && <div className="dim" style={{ whiteSpace: 'pre-wrap', fontSize: 12, maxHeight: 220, overflow: 'auto', margin: '4px 0' }}>{r.result}</div>}
          {r.error && <div className="error-text" style={{ fontSize: 12 }}>{r.error}</div>}
          {(r.status === 'done' || (r.status === 'accepted' && (r.kind === 'task_execute' || r.kind === 'task_rework'))) && (
            <div className="team-rate">
              {r.status === 'done' && <button className="btn btn-primary btn-sm" onClick={() => accept(r.id, false)}>Принять</button>}
              {r.status === 'done' && r.kind === 'task_draft' && <button className="btn btn-sm" onClick={() => accept(r.id, true)}>В чеклист</button>}
              {(r.kind === 'task_execute' || r.kind === 'task_rework') && <button className="btn btn-sm" onClick={() => rework(r.id)} disabled={busy} title="Вернуть на доработку с замечаниями"><Icon name="refresh" size={13} /> Доработать</button>}
              {r.status === 'done' && <button className="btn btn-ghost btn-sm" onClick={() => reject(r.id)}>Отклонить</button>}
            </div>
          )}
        </div>
      ))}
    </>
  );
}

function FilesTab({ taskId, onRefresh }: { taskId: string; onRefresh: () => void }) {
  const [files, setFiles] = useState<any[]>([]);
  const [preview, setPreview] = useState<{ url: string; name: string; mime: string } | null>(null);
  const [err, setErr] = useState('');
  const reload = () => api.listAttachments(taskId).then(setFiles).catch(() => undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, [taskId]);
  const upload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return;
    try { await api.uploadAttachment(taskId, f); reload(); onRefresh(); } catch { /* */ }
  };
  // файлы за авторизацией: тянем blob с токеном, картинку показываем в попапе, остальное скачиваем
  const open = async (f: any) => {
    setErr('');
    try {
      const blob = await api.authedBlob(`/api/files/${f.file_id}`);
      const url = URL.createObjectURL(blob);
      if (blob.type.startsWith('image/') || blob.type.startsWith('video/')) {
        setPreview({ url, name: f.file_name, mime: blob.type });
      } else {
        const a = document.createElement('a');
        a.href = url; a.download = f.file_name; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось открыть файл');
    }
  };
  const closePreview = () => {
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview(null);
  };
  return (
    <>
      <label className="btn btn-sm" style={{ display: 'inline-block', cursor: 'pointer' }}>
        Загрузить файл<input type="file" hidden onChange={upload} />
      </label>
      {err && <div className="error-text" style={{ marginTop: 8 }}>{err}</div>}
      {files.map((f) => (
        <div key={f.id} className="team-row team-head">
          <button className="file-link" onClick={() => open(f)}>{f.file_name}</button>
          <button className="btn btn-ghost btn-sm" onClick={async () => { await api.deleteAttachment(taskId, f.id); reload(); onRefresh(); }} title="Удалить"><Icon name="close" size={13} /></button>
        </div>
      ))}
      {files.length === 0 && (
        <EmptyState compact icon="paperclip" title="Файлов нет"
          hint="Прикрепите документы, макеты или скриншоты — они останутся в задаче и будут видны всем участникам." />
      )}
      {preview && <Lightbox url={preview.url} name={preview.name} mime={preview.mime} onClose={closePreview} />}
    </>
  );
}

function DiscussionTab({ taskId, onRefresh }: { taskId: string; onRefresh: () => void }) {
  const [comments, setComments] = useState<any[]>([]);
  const [activity, setActivity] = useState<any[]>([]);
  const [body, setBody] = useState('');
  const reload = () => { api.listComments(taskId).then(setComments).catch(() => undefined); api.taskActivity(taskId).then(setActivity).catch(() => undefined); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, [taskId]);
  const send = async () => { if (!body.trim()) return; await api.addComment(taskId, body.trim()); setBody(''); reload(); onRefresh(); };
  return (
    <>
      <div className="drawer-section-title">Комментарии</div>
      {comments.length === 0 && (
        <EmptyState compact icon="chat" title="Обсуждения ещё не было"
          hint="Здесь остаётся история решений по задаче — почему сделали так, а не иначе." />
      )}
      {comments.map((c) => (
        <div key={c.id} className="comment">
          <div className="comment-head"><b>{c.author_name}</b> <span className="dim">{new Date(c.created_at).toLocaleString('ru-RU')}</span></div>
          <div>{c.body}</div>
        </div>
      ))}
      <div className="comment-input">
        <textarea className="input" rows={2} placeholder="Написать комментарий…" value={body} onChange={(e) => setBody(e.target.value)} />
        <button className="btn btn-primary btn-sm" onClick={send}>Отправить</button>
      </div>
      <div className="drawer-section-title" style={{ marginTop: 16 }}>История</div>
      {activity.map((a) => (
        <div key={a.id} className="dim activity-row">
          {new Date(a.created_at).toLocaleString('ru-RU')} · {a.actor_name ?? 'система'} · {activityText(a)}
        </div>
      ))}
    </>
  );
}

/** Событие истории по-русски: строка вида «moved» проверяющему ничего не говорит. */
const ACTIVITY_LABEL: Record<string, string> = {
  created: 'создал задачу',
  updated: 'изменил поля',
  moved: 'перенёс',
  commented: 'написал комментарий',
  attached: 'приложил файл',
  checklist: 'правил чек-лист',
  label: 'менял метки',
  handoff_forced: 'сдал работу без полной готовности',
};

function activityText(a: { kind: string; detail?: Record<string, any> }): string {
  const label = ACTIVITY_LABEL[a.kind] ?? a.kind;
  if (a.kind === 'moved' && a.detail?.to) return `${label} в «${a.detail.to}»`;
  // обход приёмки без списка нехваток бесполезен: ради этого списка запись и делается
  if (a.kind === 'handoff_forced' && Array.isArray(a.detail?.missing)) {
    return `${label}: ${a.detail.missing.join('; ')}`;
  }
  return label;
}
