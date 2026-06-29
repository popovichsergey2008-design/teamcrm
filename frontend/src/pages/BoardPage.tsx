import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { getSocket } from '../lib/socket';
import { useAuth } from '../state/auth';
import type { Board, BoardColumn, Project, Task } from '../types';
import { ColumnView } from '../components/ColumnView';

type Action =
  | { type: 'SET'; board: Board }
  | { type: 'UPSERT_TASK'; task: Task };

function reducer(state: Board | null, action: Action): Board | null {
  switch (action.type) {
    case 'SET':
      return action.board;
    case 'UPSERT_TASK': {
      if (!state) return state;
      const t = action.task;
      // убираем задачу из всех колонок, вставляем в целевую, сортируем по position
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
  const [error, setError] = useState('');
  const [newProject, setNewProject] = useState('');
  const subscribedRef = useRef<string | null>(null);

  // загрузка проектов
  useEffect(() => {
    api
      .listProjects()
      .then((ps) => {
        setProjects(ps);
        if (ps.length && !selected) setSelected(ps[0].id);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Ошибка загрузки проектов'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // загрузка доски выбранного проекта
  useEffect(() => {
    if (!selected) return;
    api
      .getBoard(selected)
      .then((b) => dispatch({ type: 'SET', board: b }))
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Ошибка загрузки доски'));
  }, [selected]);

  // realtime: подписка на комнату проекта + применение доменных событий
  useEffect(() => {
    if (!selected) return;
    const socket = getSocket();
    const onUpsert = (t: Task) => {
      if (t.project_id === selected) dispatch({ type: 'UPSERT_TASK', task: t });
    };
    const subscribe = () => {
      socket.emit('project.subscribe', { projectId: selected });
      subscribedRef.current = selected;
    };
    socket.on('connect', subscribe);
    if (socket.connected) subscribe();
    socket.on('task.created', onUpsert);
    socket.on('task.updated', onUpsert);
    socket.on('task.moved', onUpsert);

    return () => {
      if (subscribedRef.current) socket.emit('project.unsubscribe', { projectId: subscribedRef.current });
      socket.off('connect', subscribe);
      socket.off('task.created', onUpsert);
      socket.off('task.updated', onUpsert);
      socket.off('task.moved', onUpsert);
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
      // оптимистично + реконсиляция ответом сервера; realtime-эхо идемпотентно
      const current = board?.columns.flatMap((c) => c.tasks).find((t) => t.id === taskId);
      if (current) {
        dispatch({ type: 'UPSERT_TASK', task: { ...current, column_id: columnId, position } });
      }
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
            <div className="board-title">{board.project.name}</div>
            <div className="board-columns">
              {board.columns.map((col) => (
                <ColumnView
                  key={col.id}
                  column={col}
                  canEdit={!isClient}
                  onAddTask={addTask}
                  onMoveTask={moveTask}
                />
              ))}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
