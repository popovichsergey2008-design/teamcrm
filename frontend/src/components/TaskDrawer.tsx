import { useEffect, useState } from 'react';
import { navigate } from '../lib/router';
import { useAuth } from '../state/auth';
import { EmptyState } from './EmptyState';
import { Icon } from './Icon';
import { GateBlock, HandoffGateDialog, gateFromError } from './HandoffGateDialog';
import { api, ApiError } from '../lib/api';
import type { Task, User } from '../types';
import { Lightbox } from './Lightbox';
import { DatePicker } from './DatePicker';
import { useVoiceInput } from '../hooks/useVoiceInput';
import { VoiceStatus } from './VoiceStatus';
import { MentionField } from './MentionField';
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

// Обсуждения среди вкладок больше нет: чат стоит справа и виден всегда.
type Tab = 'overview' | 'checklist' | 'files' | 'agent';
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
  const initialDeadline = (() => {
    if (!task.deadline_at) return '';
    const d = new Date(task.deadline_at);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  })();
  const [deadline, setDeadline] = useState(initialDeadline);
  const [warn, setWarn] = useState<any>(null);
  const [err, setErr] = useState('');
  const [desc, setDesc] = useState(task.description ?? '');
  /** Название правится прямо в карточке: раньше его можно было изменить только заново создав задачу. */
  const [title, setTitle] = useState(task.title ?? '');
  const [priority, setPriority] = useState(task.priority ?? 'normal');
  const { user } = useAuth();
  /** Решение принимает постановщик; владельцу тоже даём — он последняя инстанция. */
  const isManager = String(task.created_by ?? '') === String(user?.id ?? '') || user?.role === 'owner';
  /**
   * Кто ещё в задаче: соисполнители делают работу вместе с исполнителем,
   * наблюдатели только следят и получают уведомления.
   */
  const [participants, setParticipants] = useState<{ user_id: string; role: string; full_name: string }[]>([]);
  const loadParticipants = () => api.taskParticipants(task.id).then(setParticipants).catch(() => undefined);
  // Перечитываем только при смене задачи: список меняется нашими же действиями,
  // и ответ сервера сразу кладётся в состояние.
  useEffect(() => {
    void loadParticipants();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  const addPerson = async (userId: string, role: 'co_assignee' | 'watcher') => {
    if (!userId) return;
    setErr('');
    try { setParticipants(await api.addTaskParticipant(task.id, userId, role)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось добавить'); }
  };
  const removePerson = async (userId: string, role: 'co_assignee' | 'watcher') => {
    setErr('');
    try { setParticipants(await api.removeTaskParticipant(task.id, userId, role)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось убрать'); }
  };

  /** Встреча, из которой выросла задача: обратный переход в её Summary. */
  const [meeting, setMeeting] = useState<{ meeting_id: string; title: string | null } | null>(null);
  useEffect(() => {
    api.meetingOfTask(task.id).then(setMeeting).catch(() => setMeeting(null));
  }, [task.id]);
  const [managerId, setManagerId] = useState(task.created_by ?? '');

  /** Есть ли что сохранять в блоке назначения: кнопка не должна лгать о работе. */
  const planChanged = String(assigneeId ?? '') !== String(task.assignee_id ?? '')
    || String(estimate ?? '') !== String(task.estimate_hours ?? '')
    || deadline !== initialDeadline;

  const userName = (id?: string | null) => users.find((u) => u.id === id)?.fullName ?? '—';
  const changeManager = async (id: string) => {
    setManagerId(id);
    await api.updateTask(task.id, { managerId: id || null });
    onRefresh();
  };

  /**
   * Сохранить назначение и план.
   *
   * Раньше кнопка называлась «Назначить» и требовала исполнителя: поставить срок
   * задаче, которую ещё не на кого повесить, было нельзя, а «сохранить» в карточке
   * не находилось вовсе. Теперь сохраняется то, что человек изменил: план — всегда,
   * исполнитель — если он выбран или снят.
   */
  const savePlan = async (confirmOverload: boolean) => {
    setErr('');
    const estimateHours = estimate ? Number(estimate) : undefined;
    const deadlineAt = deadline ? new Date(deadline).toISOString() : undefined;
    const changedAssignee = String(assigneeId ?? '') !== String(task.assignee_id ?? '');
    try {
      if (assigneeId && (changedAssignee || confirmOverload)) {
        // назначение идёт через прогноз — он и предупредит о перегрузе
        const res = await api.assignTask(task.id, { assigneeId, confirmOverload, estimateHours, deadlineAt });
        if (res.warning && !confirmOverload) return setWarn(res);
        setWarn(null);
      } else {
        if (estimateHours !== undefined || deadlineAt !== undefined) {
          await api.saveTaskPlan(task.id, { estimateHours, deadlineAt });
        }
        // исполнителя сняли — задача снова ничья, и это законное состояние
        if (!assigneeId && task.assignee_id) await api.updateTask(task.id, { assigneeId: null });
        setWarn(null);
      }
      onRefresh();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Ошибка'); }
  };
  /**
   * Решение постановщика по сданной работе.
   *
   * Обе кнопки живут в карточке, а не на доске: чтобы принять работу, надо сначала
   * её посмотреть, а «принять не глядя» — способ обесценить всю затею.
   */
  const decide = async (accept: boolean) => {
    setErr('');
    try {
      if (accept) await api.approveTask(task.id);
      else {
        const reason = window.prompt('Что доработать? Причина уйдёт исполнителю и останется в истории задачи.');
        if (!reason?.trim()) return; // молча вернуть работу нельзя — это ссора на ровном месте
        await api.returnTask(task.id, reason.trim());
      }
      onRefresh();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Ошибка'); }
  };

  const toggleApproval = async (enabled: boolean) => {
    setErr('');
    try { await api.setTaskApproval(task.id, enabled); onRefresh(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Ошибка'); }
  };

  /** Название и описание — одна правка: их и меняют вместе. */
  const saveText = async () => {
    if (!title.trim()) return setErr('Название не может быть пустым');
    setErr('');
    try {
      await api.updateTask(task.id, { title: title.trim(), description: desc });
      onRefresh();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Ошибка'); }
  };
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
      {/*
        Карточка и чат стоят рядом постоянно, как в Битриксе: слева задача целиком —
        со всеми полями, статусами и вкладками, справа разговор по ней.
        Чат вкладкой не работает: обсуждать задачу, не видя её условий, значит держать
        их в голове и прыгать туда-обратно. Окно от этого шире обычного — и должно быть.
      */}
      <aside className="drawer drawer-task" onClick={(e) => e.stopPropagation()}>
        <div className="task-main">
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
            {/* Работа сдана и ждёт решения: блок стоит первым — это главное, что
                сейчас происходит с задачей, и адресован он конкретному человеку. */}
            {task.approval_state === 'pending' && (
              <div className="approval-box">
                <div className="approval-head">
                  <Icon name="alert" size={15} /> Работа сдана и ждёт решения постановщика
                </div>
                {isManager ? (
                  <div className="team-rate">
                    <button className="btn btn-primary btn-sm" onClick={() => decide(true)}>Принять работу</button>
                    <button className="btn btn-sm" onClick={() => decide(false)}>Вернуть в работу</button>
                  </div>
                ) : (
                  <div className="dim" style={{ fontSize: 12 }}>
                    Решает {userName(task.created_by ?? null)} — задача завершится после подтверждения.
                  </div>
                )}
              </div>
            )}

            {meeting && (
              // Обратная ссылка: из задачи видно, на какой встрече её поручили
              <div className="dim task-origin">
                <Icon name="record" size={12} /> Создано по итогам встречи:{' '}
                <button className="link-btn" onClick={() => navigate({ section: 'chat', view: 'meetings' })}>
                  {meeting.title || 'встреча'}
                </button>
              </div>
            )}

            <div className="field"><label>Название</label>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="field"><label>Описание (Markdown)</label>
              <textarea className="input" rows={5} value={desc} onChange={(e) => setDesc(e.target.value)} />
              {/* Кнопка появляется, только когда есть что сохранять: постоянно висящее
                  «Сохранить» не отвечает на вопрос «мои правки уже применились?». */}
              {(title !== (task.title ?? '') || desc !== (task.description ?? '')) && (
                <button className="btn btn-primary btn-sm" style={{ marginTop: 6 }} onClick={saveText}>
                  Сохранить
                </button>
              )}
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
              {/* Соисполнители и наблюдатели — рядом с исполнителем и постановщиком:
                  это ответ на тот же вопрос «кто в этой задаче». */}
              <PeopleField
                label="Соисполнители"
                hint="Делают работу вместе с исполнителем и видят задачу в своих"
                role="co_assignee"
                people={participants}
                users={users}
                onAdd={addPerson}
                onRemove={removePerson}
              />
              <PeopleField
                label="Наблюдатели"
                hint="Следят за ходом и получают уведомления, выполнять не обязаны"
                role="watcher"
                people={participants}
                users={users}
                onAdd={addPerson}
                onRemove={removePerson}
              />

              <div className="drawer-grid2">
                <div className="field"><label>Оценка, ч</label><input className="input" type="number" min="0" step="0.5" value={estimate} onChange={(e) => setEstimate(e.target.value)} /></div>
                <div className="field"><label>Дедлайн</label>
                  <DatePicker value={deadline} onChange={setDeadline} withTime warnPast placeholder="срок не задан" />
                </div>
              </div>
              {warn && (
                <div className="overload-warn"><Icon name="alert" size={13} /> Перегруз: риск {warn.riskPct ?? '—'}%, {warn.projectedHours}ч &gt; {warn.capacityHours}ч/нед.
                  <button className="btn btn-sm overload-confirm" onClick={() => savePlan(true)}>Всё равно назначить</button>
                </div>
              )}
              {/* Переключатель согласования — право постановщика, пока задача жива. */}
              <label className="notify-row" title="Исполнитель сдаёт работу, завершаете её вы">
                <input
                  type="checkbox"
                  checked={task.requires_approval !== false}
                  disabled={!isManager || !!task.closed_at}
                  onChange={(e) => toggleApproval(e.target.checked)}
                />
                Не завершать без согласования с постановщиком
              </label>
              <button className="btn btn-primary drawer-assign" onClick={() => savePlan(false)} disabled={!planChanged}>
                {planChanged ? 'Сохранить' : 'Сохранено'}
              </button>
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
        </div>

        {/* Правая колонка — чат задачи. Он на виду всегда: обсуждение и есть работа
            по задаче, а не отдельный раздел, в который надо переключаться. */}
        <div className="task-chat">
          <DiscussionTab taskId={task.id} onRefresh={onRefresh} />
        </div>
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

/** Готовые вопросы: их задают чаще всего, и набирать их руками каждый раз незачем. */
const QUICK_ASKS: { label: string; ask: string }[] = [
  { label: 'Объяснить задачу', ask: 'Объясни коротко и простыми словами, что от меня требуется по этой задаче.' },
  { label: 'Составить план', ask: 'Предложи порядок действий по этой задаче.' },
  { label: 'Что осталось', ask: 'Что по этой задаче ещё не сделано? Сверься с чек-листом и обсуждением.' },
  { label: 'Резюме обсуждения', ask: 'Кратко подведи итог обсуждения: что решили, что изменилось, какие вопросы открыты.' },
  { label: 'Отчёт постановщику', ask: 'Подготовь короткий отчёт о проделанной работе для постановщика.' },
];

/**
 * Помощник в списке упоминаний.
 *
 * Зовут его так же, как коллегу, — через «@». Отдельная кнопка делала из ИИ
 * инструмент в стороне от разговора, хотя он участник этого разговора.
 */
const AI_MENTION_ID = 'ai';
const AI_MENTION_NAME = 'AI-помощник';
/** «@AI», «@AI-помощник», «@ai,» — человек пишет как придётся. */
const MENTIONS_AI = /@(ai|ии|ai-помощник)\b/gi;

/** Реакции: ответить «ок» знаком, не засоряя обсуждение и не будя участников. */
const REACTIONS = ['👍', '✅', '🔥', '❓'];

/**
 * Обсуждение задачи: чат команды и помощник, который знает эту задачу.
 *
 * Здесь и переписка людей, и ИИ — намеренно в одной ленте: разговор о работе один,
 * и разносить его по двум местам значит заставлять человека помнить, где что искать.
 * Ответы помощника видно как ответы помощника: спутать догадку с указанием
 * постановщика — самая дорогая ошибка, какую здесь можно совершить.
 */
function DiscussionTab({ taskId, onRefresh }: { taskId: string; onRefresh: () => void }) {
  const { user } = useAuth();
  const [comments, setComments] = useState<any[]>([]);
  const [activity, setActivity] = useState<any[]>([]);
  const [users, setUsers] = useState<{ id: string; fullName: string }[]>([]);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  /** Поиск по обсуждению: в переписке на сотню сообщений нужное иначе не найти. */
  const [query, setQuery] = useState('');
  /** На какое сообщение отвечаем — цитата стоит над полем ввода. */
  const [replyTo, setReplyTo] = useState<any | null>(null);
  /** Правка своего сообщения: сказанное вслух не переписывают, написанное — да. */
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [advice, setAdvice] = useState<{
    answer: string; checklist: string[]; suggestion: { field: string; value: string; label: string } | null;
  } | null>(null);

  const reload = () => {
    api.listComments(taskId).then(setComments).catch(() => undefined);
    api.taskActivity(taskId).then(setActivity).catch(() => undefined);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, [taskId]);
  useEffect(() => {
    api.listUsers()
      .then((team: any[]) => setUsers(team.map((u) => ({ id: String(u.id), fullName: u.fullName }))))
      .catch(() => undefined);
  }, []);

  /**
   * Помощник стоит в том же списке, что и люди.
   *
   * Отдельная кнопка «Спросить ИИ» делала из него инструмент, к которому надо
   * тянуться; в разговоре же его зовут так же, как коллегу, — через «@». Поэтому
   * он просто первый в списке упоминаний.
   */
  const mentionUsers = [{ id: AI_MENTION_ID, fullName: AI_MENTION_NAME }, ...users];

  const ask = async (question: string) => {
    if (!question.trim()) return;
    setBusy(true); setErr(''); setAdvice(null);
    try {
      const res = await api.askTaskAssistant(taskId, question.trim());
      setAdvice(res);
      setBody('');
      reload(); // ответ лёг в ленту обсуждения — он часть истории задачи
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Помощник не ответил'); }
    finally { setBusy(false); }
  };

  const send = async () => {
    const text = body.trim();
    if (!text) return;
    // Помощника зовут упоминанием, как коллегу: «@AI-помощник, что тут по срокам».
    // Проверяем в любом месте строки, а не только в начале, — в живой переписке
    // обращение часто идёт после слов «Борис, глянь, и @AI тоже».
    if (MENTIONS_AI.test(text)) return ask(text.replace(MENTIONS_AI, ' ').trim() || text);
    setBusy(true);
    try {
      if (editing) {
        await api.editComment(taskId, editing.id, text);
        setEditing(null);
      } else {
        await api.addComment(taskId, text, undefined, replyTo ? String(replyTo.id) : undefined);
      }
      setBody(''); setReplyTo(null); reload(); onRefresh();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не отправилось'); }
    finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    if (!window.confirm('Удалить сообщение? Восстановить его будет нельзя.')) return;
    try { await api.deleteComment(taskId, id); reload(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалилось'); }
  };

  const react = async (id: string, emoji: string) => {
    // Оптимистично: реакция должна ставиться мгновенно, это её единственная ценность.
    setComments((prev) => prev.map((c) => {
      if (String(c.id) !== String(id)) return c;
      const list = [...(c.reactions ?? [])];
      const found = list.find((r: any) => r.emoji === emoji);
      if (found) {
        found.mine ? (found.count -= 1) : (found.count += 1);
        found.mine = !found.mine;
      } else list.push({ emoji, count: 1, mine: true });
      return { ...c, reactions: list.filter((r: any) => r.count > 0) };
    }));
    try { await api.reactToComment(taskId, id, emoji); } catch { reload(); }
  };

  // Голос: вопрос помощнику проще задать словами, чем набирать на телефоне.
  const voice = useVoiceInput((text) => { setBody((prev) => (prev.trim() ? prev.trim() + ' ' + text : text)); });

  const acceptChecklist = async () => {
    if (!advice?.checklist.length) return;
    setBusy(true);
    try { await api.applyAssistantChecklist(taskId, advice.checklist); setAdvice(null); onRefresh(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не добавилось'); }
    finally { setBusy(false); }
  };

  const q = query.trim().toLowerCase();
  const shown = q ? comments.filter((c) => String(c.body ?? '').toLowerCase().includes(q)) : comments;

  return (
    <>
      <div className="drawer-section-title">
        <Icon name="chat" size={14} /> Чат задачи
      </div>

      {/* Поиск появляется, когда искать есть в чём: над тремя сообщениями он лишний. */}
      {comments.length > 5 && (
        <input
          className="input chat-search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Поиск по обсуждению"
          aria-label="Поиск по обсуждению"
        />
      )}
      {q && (
        <div className="dim" style={{ fontSize: 12 }}>
          {shown.length ? `Найдено сообщений: ${shown.length}` : 'Ничего не нашлось'}
        </div>
      )}

      {comments.length === 0 && (
        <EmptyState compact icon="chat" title="Обсуждения ещё не было"
          hint="Здесь остаётся история решений по задаче. Помощника можно спросить тут же: «@AI что от меня требуется?»" />
      )}

      {shown.map((c) => (
        <div key={c.id} className={c.is_ai ? 'comment comment-ai' : 'comment'}>
          <div className="comment-head">
            <b>{c.is_ai ? 'AI-помощник' : c.author_name}</b>
            {c.is_ai && <span className="badge badge-info">ИИ</span>}
            <span className="dim">{new Date(c.created_at).toLocaleString('ru-RU')}</span>
            {c.edited_at && <span className="dim">· изменено</span>}
          </div>

          {/* Цитата: без неё «да, согласен» через десять реплик — согласие неизвестно с чем. */}
          {c.reply_to_id && c.reply_body && (
            <div className="comment-quote">
              <b>{c.reply_author}</b>: {String(c.reply_body).slice(0, 160)}
            </div>
          )}

          <div className="comment-body">{c.body}</div>

          <div className="comment-tools">
            {(c.reactions ?? []).map((r: any) => (
              <button
                key={r.emoji}
                className={r.mine ? 'reaction mine' : 'reaction'}
                onClick={() => react(String(c.id), r.emoji)}
                title="Ваша реакция"
              >
                {r.emoji} {r.count}
              </button>
            ))}
            <span className="comment-tools-add">
              {REACTIONS.map((emoji) => (
                <button key={emoji} className="reaction reaction-add" onClick={() => react(String(c.id), emoji)} title="Поставить реакцию">
                  {emoji}
                </button>
              ))}
            </span>
            {!c.is_ai && (
              <button className="comment-link" onClick={() => { setReplyTo(c); setEditing(null); }}>Ответить</button>
            )}
            {String(c.author_id) === String(user?.id ?? '') && !c.is_ai && (
              <>
                <button className="comment-link" onClick={() => { setEditing({ id: String(c.id), body: c.body }); setBody(c.body); setReplyTo(null); }}>
                  Изменить
                </button>
                <button className="comment-link" onClick={() => remove(String(c.id))}>Удалить</button>
              </>
            )}
          </div>
        </div>
      ))}

      {err && <div className="error-text">{err}</div>}

      {/* Предложения помощника: применяет их человек, и это принципиально —
          сам ИИ задачу не меняет. */}
      {advice && (advice.checklist.length > 0 || advice.suggestion) && (
        <div className="ai-advice">
          {advice.checklist.length > 0 && (
            <>
              <div className="ai-advice-head">Предложенные шаги</div>
              <ul className="ai-advice-list">
                {advice.checklist.map((step, i) => <li key={i}>{step}</li>)}
              </ul>
              <button className="btn btn-sm" onClick={acceptChecklist} disabled={busy}>
                <Icon name="check" size={13} /> Добавить в чек-лист
              </button>
            </>
          )}
          {advice.suggestion && (
            <div className="ai-advice-suggest">
              <Icon name="alert" size={13} /> {advice.suggestion.label || 'Помощник предлагает изменить задачу'} —
              примените это сами во вкладке «Обзор»: менять задачу за вас он не станет.
            </div>
          )}
        </div>
      )}

      <div className="ai-quick">
        {QUICK_ASKS.map((qa) => (
          <button key={qa.label} className="btn btn-ghost btn-sm" disabled={busy} onClick={() => ask(qa.ask)}>
            {qa.label}
          </button>
        ))}
      </div>

      {/* Кому отвечаем или что правим — видно прямо над полем, а не угадывается. */}
      {(replyTo || editing) && (
        <div className="comment-reply-to">
          <Icon name={editing ? 'edit' : 'reply'} size={13} />
          <span className="dim">
            {editing ? 'Правите своё сообщение' : `В ответ ${replyTo.author_name}: ${String(replyTo.body).slice(0, 60)}`}
          </span>
          <button className="comment-link" onClick={() => { setReplyTo(null); setEditing(null); setBody(''); }}>Отмена</button>
        </div>
      )}

      <div className="comment-input">
        <MentionField
          value={body}
          users={mentionUsers}
          onChange={setBody}
          // Упомянутого нужно позвать: без этого «@Юрий, посмотри» он увидит,
          // только если сам зайдёт в задачу.
          onMention={(userId) => {
            // помощник участником задачи не становится — он не человек
            if (userId === AI_MENTION_ID) return;
            void api.addTaskParticipant(taskId, userId, 'watcher').catch(() => undefined);
          }}
          rows={2}
          placeholder="Нажмите @, чтобы позвать человека или помощника"
          onEnter={send}
        />
        <div className="comment-actions">
          <button
            className={voice.recording ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-ghost'}
            onClick={voice.toggle}
            disabled={busy || voice.transcribing}
            title="Задать вопрос голосом"
          >
            <Icon name={voice.recording ? 'stop' : 'mic'} size={14} />
          </button>
          <button className="btn btn-primary btn-sm" disabled={busy || !body.trim()} onClick={send}>
            {busy ? '…' : editing ? 'Сохранить' : 'Отправить'}
          </button>
        </div>
      </div>
      <VoiceStatus recording={voice.recording} transcribing={voice.transcribing} error={voice.error} className="nl-voice" />

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

/**
 * Список людей в задаче с добавлением и удалением.
 *
 * Одним компонентом для обеих ролей: соисполнители и наблюдатели отличаются смыслом,
 * а не устройством, и два почти одинаковых блока разошлись бы на первой же правке.
 */
function PeopleField({ label, hint, role, people, users, onAdd, onRemove }: {
  label: string;
  hint: string;
  role: 'co_assignee' | 'watcher';
  people: { user_id: string; role: string; full_name: string }[];
  users: { id: string; fullName: string }[];
  onAdd: (userId: string, role: 'co_assignee' | 'watcher') => void;
  onRemove: (userId: string, role: 'co_assignee' | 'watcher') => void;
}) {
  const mine = people.filter((p) => p.role === role);
  const taken = new Set(mine.map((p) => String(p.user_id)));

  return (
    <div className="field">
      <label title={hint}>{label}</label>
      {mine.length > 0 && (
        <div className="people-chips">
          {mine.map((p) => (
            <span key={p.user_id} className="people-chip">
              {p.full_name}
              <button
                className="people-chip-x"
                onClick={() => onRemove(String(p.user_id), role)}
                title="Убрать из задачи"
                aria-label={`Убрать ${p.full_name}`}
              >
                <Icon name="close" size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <select
        className="input"
        value=""
        onChange={(e) => { onAdd(e.target.value, role); e.currentTarget.value = ''; }}
      >
        <option value="">+ добавить</option>
        {users.filter((u) => !taken.has(String(u.id))).map((u) => (
          <option key={u.id} value={u.id}>{u.fullName}</option>
        ))}
      </select>
    </div>
  );
}
