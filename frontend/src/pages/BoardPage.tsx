import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { getSocket } from '../lib/socket';
import { useAuth } from '../state/auth';
import type { Board, BoardColumn, Pnl, Project, Task, User } from '../types';
import { ColumnView } from '../components/ColumnView';
import { PnlPanel } from '../components/PnlPanel';
import { TaskDrawer } from '../components/TaskDrawer';
import { TaskCreateModal } from '../components/TaskCreateModal';
import { TaskListView } from '../components/TaskListView';
import { TeamPanel } from '../components/TeamPanel';
import { CopilotPanel } from '../components/CopilotPanel';
import { MONETIZATION_ENABLED } from '../config';

type Action =
  | { type: 'SET'; board: Board }
  | { type: 'CLEAR' }
  | { type: 'UPSERT_TASK'; task: Task }
  | { type: 'SET_COST'; taskId: string; cost: string };

function reducer(state: Board | null, action: Action): Board | null {
  // SET/CLEAR обрабатываются ДО guard на null — иначе начальная загрузка доски не применится
  if (action.type === 'SET') return action.board;
  if (action.type === 'CLEAR') return null;
  if (!state) return state;
  switch (action.type) {
    case 'UPSERT_TASK': {
      const t = action.task;
      const columns: BoardColumn[] = state.columns.map((c) => ({
        ...c,
        tasks: c.tasks.filter((x) => x.id !== t.id),
      }));
      const target = columns.find((c) => c.id === t.column_id);
      if (target) {
        target.tasks.push(t);
        target.tasks.sort((a, b) => a.position - b.position);
      }
      return { ...state, columns };
    }
    case 'SET_COST': {
      const columns = state.columns.map((c) => ({
        ...c,
        tasks: c.tasks.map((t) => (t.id === action.taskId ? { ...t, cost_current: action.cost } : t)),
      }));
      return { ...state, columns };
    }
    default:
      return state;
  }
}

export function BoardPage() {
  const { user } = useAuth();
  const isClient = user?.role === 'client';
  const canManageProjects = user?.role === 'owner' || user?.role === 'manager';
  const showFinance = !isClient && MONETIZATION_ENABLED;

  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [board, dispatch] = useReducer(reducer, null);
  const [pnl, setPnl] = useState<Pnl | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const [activeTimerTask, setActiveTimerTask] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [newProject, setNewProject] = useState('');
  const [users, setUsers] = useState<User[]>([]);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [createIn, setCreateIn] = useState<{ columnId: string; columnName: string } | null>(null);
  const [view, setView] = useState<'board' | 'list'>(() =>
    localStorage.getItem('teamcrm.boardView') === 'list' ? 'list' : 'board',
  );
  const switchView = (v: 'board' | 'list') => { setView(v); localStorage.setItem('teamcrm.boardView', v); };
  const [showTeam, setShowTeam] = useState(false);
  const [showCopilot, setShowCopilot] = useState(false);
  const subscribedRef = useRef<string | null>(null);

  const reloadBoard = useCallback(() => {
    if (!selected) return;
    api.getBoard(selected).then((b) => dispatch({ type: 'SET', board: b })).catch(() => undefined);
    if (showFinance) api.getPnl(selected).then(setPnl).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, isClient]);

  useEffect(() => {
    api
      .listProjects()
      .then((ps) => {
        setProjects(ps);
        if (ps.length && !selected) setSelected(ps[0].id);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Ошибка загрузки проектов'));
    if (!isClient) {
      api.myTimer().then((t) => setActiveTimerTask(t?.taskId ?? null)).catch(() => undefined);
      api.listUsers().then(setUsers).catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selected) {
      dispatch({ type: 'CLEAR' });
      setPnl(null);
      return;
    }
    setAlert(null);
    api
      .getBoard(selected)
      .then((b) => dispatch({ type: 'SET', board: b }))
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Ошибка загрузки доски'));
    if (showFinance) {
      api.getPnl(selected).then(setPnl).catch(() => setPnl(null));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, isClient]);

  // realtime: доменные + финансовые события
  useEffect(() => {
    if (!selected) return;
    const socket = getSocket();
    const onUpsert = (t: Task) => t.project_id === selected && dispatch({ type: 'UPSERT_TASK', task: t });
    const onCost = (p: { id: string; project_id: string; cost_current: string }) =>
      p.project_id === selected && dispatch({ type: 'SET_COST', taskId: p.id, cost: p.cost_current });
    const onPnl = (p: Pnl) => p.projectId === selected && setPnl(p);
    const onAlert = (a: { projectId: string; margin: number; threshold: number }) =>
      String(a.projectId) === String(selected) &&
      setAlert(`Маржа ${a.margin}% ниже порога ${a.threshold}%`);
    const onAlertResolved = (a: { projectId: string }) =>
      String(a.projectId) === String(selected) && setAlert(null);
    const onColumns = (p: { projectId: string }) =>
      String(p.projectId) === String(selected) && reloadBoard();

    const subscribe = () => {
      socket.emit('project.subscribe', { projectId: selected });
      subscribedRef.current = selected;
    };
    socket.on('connect', subscribe);
    if (socket.connected) subscribe();
    socket.on('task.created', onUpsert);
    socket.on('task.updated', onUpsert);
    socket.on('task.moved', onUpsert);
    socket.on('task.cost_changed', onCost);
    socket.on('project.pnl_changed', onPnl);
    socket.on('alert.raised', onAlert);
    socket.on('alert.resolved', onAlertResolved);
    socket.on('column.updated', onColumns);

    return () => {
      if (subscribedRef.current) socket.emit('project.unsubscribe', { projectId: subscribedRef.current });
      socket.off('connect', subscribe);
      socket.off('task.created', onUpsert);
      socket.off('task.updated', onUpsert);
      socket.off('task.moved', onUpsert);
      socket.off('task.cost_changed', onCost);
      socket.off('project.pnl_changed', onPnl);
      socket.off('alert.raised', onAlert);
      socket.off('alert.resolved', onAlertResolved);
      socket.off('column.updated', onColumns);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const createProject = async () => {
    if (!newProject.trim()) return;
    try {
      const p = await api.createProject({ name: newProject.trim() });
      setProjects((prev) => [p, ...prev]);
      setNewProject('');
      setSelected(p.id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось создать проект');
    }
  };

  const deleteProject = async (id: string, name: string) => {
    if (!window.confirm(`Удалить проект «${name}» со всеми задачами? Действие необратимо.`)) return;
    try {
      await api.deleteProject(id);
      setProjects((prev) => {
        const rest = prev.filter((p) => p.id !== id);
        if (selected === id) setSelected(rest[0]?.id ?? null);
        return rest;
      });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось удалить проект');
    }
  };

  const addColumn = async () => {
    if (!selected) return;
    const name = window.prompt('Название колонки:');
    if (!name || !name.trim()) return;
    try {
      await api.addColumn(selected, name.trim());
      reloadBoard();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось добавить колонку');
    }
  };

  const renameColumn = async (columnId: string, name: string) => {
    if (!selected) return;
    try {
      await api.renameColumn(selected, columnId, name);
      reloadBoard();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось переименовать колонку');
    }
  };

  const moveColumn = async (columnId: string, direction: 'left' | 'right') => {
    if (!selected) return;
    try {
      await api.moveColumn(selected, columnId, direction);
      reloadBoard();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось переместить колонку');
    }
  };

  const deleteColumn = async (columnId: string, name: string) => {
    if (!selected) return;
    if (!window.confirm(`Удалить колонку «${name}»? Её задачи переедут в первую колонку.`)) return;
    try {
      await api.deleteColumn(selected, columnId);
      reloadBoard();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось удалить колонку');
    }
  };

  const reorderColumns = async (sourceId: string, targetId: string) => {
    if (!selected || !board || sourceId === targetId) return;
    const ids = board.columns.map((c) => c.id);
    const from = ids.indexOf(sourceId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, sourceId);
    try {
      await api.reorderColumns(selected, ids);
      reloadBoard();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось переставить колонки');
    }
  };

  const openCreate = (columnId: string) => {
    const col = board?.columns.find((c) => c.id === columnId);
    setCreateIn({ columnId, columnName: col?.name ?? '' });
  };

  const moveTask = useCallback(
    async (taskId: string, columnId: string, position: number) => {
      const current = board?.columns.flatMap((c) => c.tasks).find((t) => t.id === taskId);
      if (current) dispatch({ type: 'UPSERT_TASK', task: { ...current, column_id: columnId, position } });
      try {
        const server = await api.moveTask(taskId, { columnId, position });
        dispatch({ type: 'UPSERT_TASK', task: server });
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Не удалось перенести задачу');
        if (selected) api.getBoard(selected).then((b) => dispatch({ type: 'SET', board: b }));
      }
    },
    [board, selected],
  );

  const toggleTimer = useCallback(
    async (taskId: string) => {
      try {
        if (activeTimerTask === taskId) {
          await api.stopTimer(taskId);
          setActiveTimerTask(null);
        } else {
          await api.startTimer(taskId);
          setActiveTimerTask(taskId); // старт автоматически закрыл предыдущий
        }
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Ошибка таймера');
      }
    },
    [activeTimerTask],
  );

  const openTask = board?.columns.flatMap((c) => c.tasks).find((t) => t.id === openTaskId) ?? null;

  return (
    <div className="board-layout">
      <aside className="sidebar">
        <div className="sidebar-head">Проекты</div>
        <div className="project-list">
          {projects.map((p) => (
            <div key={p.id} className={`project-row ${p.id === selected ? 'active' : ''}`}>
              <button className="project-item" onClick={() => setSelected(p.id)}>
                {p.name}
              </button>
              {canManageProjects && (
                <button
                  className="project-del"
                  title="Удалить проект"
                  onClick={() => deleteProject(p.id, p.name)}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          {projects.length === 0 && <div className="muted sidebar-empty">Пока нет проектов</div>}
        </div>
        {canManageProjects && (
          <div className="new-project">
            <input
              className="input"
              placeholder="Новый проект"
              value={newProject}
              onChange={(e) => setNewProject(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createProject()}
            />
            <button className="btn btn-primary btn-sm" onClick={createProject}>
              +
            </button>
          </div>
        )}
      </aside>

      <main className="board-main">
        {error && <div className="error-text board-error">{error}</div>}
        {!board && <div className="muted board-placeholder">Выберите проект</div>}
        {board && (
          <>
            <div className="board-header">
              <div className="board-title">
                {board.project.name}
                <span className="view-switch" role="tablist" aria-label="Вид доски">
                  <button className={`view-btn ${view === 'board' ? 'active' : ''}`} onClick={() => switchView('board')} title="Канбан-доска">▦ Доска</button>
                  <button className={`view-btn ${view === 'list' ? 'active' : ''}`} onClick={() => switchView('list')} title="Список">☰ Список</button>
                </span>
                {!isClient && (
                  <span className="board-actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => setShowTeam(true)}>Команда</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setShowCopilot(true)}>Co-pilot</button>
                  </span>
                )}
              </div>
              {showFinance && <PnlPanel pnl={pnl} alert={alert} />}
            </div>
            {view === 'list' ? (
              <TaskListView
                board={board}
                users={users}
                canTrack={!isClient}
                activeTimerTask={activeTimerTask}
                onOpenTask={(t) => setOpenTaskId(t.id)}
                onToggleTimer={toggleTimer}
              />
            ) : (
              <div className="board-columns">
                {board.columns.map((col, idx) => (
                  <ColumnView
                    key={col.id}
                    column={col}
                    users={users}
                    canEdit={!isClient}
                    canTrack={!isClient}
                    canManage={canManageProjects}
                    isFirst={idx === 0}
                    isLast={idx === board.columns.length - 1}
                    activeTimerTask={activeTimerTask}
                    onRequestAddTask={openCreate}
                    onMoveTask={moveTask}
                    onToggleTimer={toggleTimer}
                    onOpenTask={(t) => setOpenTaskId(t.id)}
                    onRenameColumn={renameColumn}
                    onMoveColumn={moveColumn}
                    onDeleteColumn={deleteColumn}
                    onColumnDrop={reorderColumns}
                  />
                ))}
                {canManageProjects && (
                  <button className="add-column" onClick={addColumn} title="Добавить колонку">
                    + колонка
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </main>

      {openTask && (
        <TaskDrawer
          task={openTask}
          users={users}
          timerActive={activeTimerTask === openTask.id}
          onToggleTimer={toggleTimer}
          onClose={() => setOpenTaskId(null)}
          onRefresh={reloadBoard}
        />
      )}
      {createIn && selected && (
        <TaskCreateModal
          projectId={selected}
          columnId={createIn.columnId}
          columnName={createIn.columnName}
          users={users}
          defaultManagerId={user?.id}
          onClose={() => setCreateIn(null)}
          onCreated={reloadBoard}
        />
      )}
      {showTeam && <TeamPanel onClose={() => setShowTeam(false)} />}
      {showCopilot && <CopilotPanel onClose={() => setShowCopilot(false)} onRefresh={reloadBoard} />}
    </div>
  );
}
