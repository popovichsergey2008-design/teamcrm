import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { getSocket } from '../lib/socket';
import { useAuth } from '../state/auth';
import type { Board, BoardColumn, Pnl, Project, Task } from '../types';
import { ColumnView } from '../components/ColumnView';
import { PnlPanel } from '../components/PnlPanel';

type Action =
  | { type: 'SET'; board: Board }
  | { type: 'UPSERT_TASK'; task: Task }
  | { type: 'SET_COST'; taskId: string; cost: string };

function reducer(state: Board | null, action: Action): Board | null {
  // SET обрабатывается ДО guard на null — иначе начальная загрузка доски не применится
  if (action.type === 'SET') return action.board;
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

  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [board, dispatch] = useReducer(reducer, null);
  const [pnl, setPnl] = useState<Pnl | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const [activeTimerTask, setActiveTimerTask] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [newProject, setNewProject] = useState('');
  const subscribedRef = useRef<string | null>(null);

  useEffect(() => {
    api
      .listProjects()
      .then((ps) => {
        setProjects(ps);
        if (ps.length && !selected) setSelected(ps[0].id);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Ошибка загрузки проектов'));
    if (!isClient) api.myTimer().then((t) => setActiveTimerTask(t?.taskId ?? null)).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selected) return;
    setAlert(null);
    api
      .getBoard(selected)
      .then((b) => dispatch({ type: 'SET', board: b }))
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Ошибка загрузки доски'));
    if (!isClient) {
      api.getPnl(selected).then(setPnl).catch(() => setPnl(null));
    }
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
    };
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

  const addTask = async (columnId: string, title: string) => {
    if (!selected) return;
    try {
      const task = await api.createTask({ projectId: selected, columnId, title });
      dispatch({ type: 'UPSERT_TASK', task });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось создать задачу');
    }
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

  return (
    <div className="board-layout">
      <aside className="sidebar">
        <div className="sidebar-head">Проекты</div>
        <div className="project-list">
          {projects.map((p) => (
            <button
              key={p.id}
              className={`project-item ${p.id === selected ? 'active' : ''}`}
              onClick={() => setSelected(p.id)}
            >
              {p.name}
            </button>
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
              <div className="board-title">{board.project.name}</div>
              {!isClient && <PnlPanel pnl={pnl} alert={alert} />}
            </div>
            <div className="board-columns">
              {board.columns.map((col) => (
                <ColumnView
                  key={col.id}
                  column={col}
                  canEdit={!isClient}
                  canTrack={!isClient}
                  activeTimerTask={activeTimerTask}
                  onAddTask={addTask}
                  onMoveTask={moveTask}
                  onToggleTimer={toggleTimer}
                />
              ))}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
