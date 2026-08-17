import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { api, ApiError } from '../lib/api';
import { getSocket } from '../lib/socket';
import { useAuth } from '../state/auth';
import type { Board, BoardColumn, CostOfWork, Pnl, Project, Task, User } from '../types';
import { ColumnView } from '../components/ColumnView';
import { PnlPanel } from '../components/PnlPanel';
import { TaskDrawer } from '../components/TaskDrawer';
import { TaskCreateModal } from '../components/TaskCreateModal';
import { TaskListView } from '../components/TaskListView';
import { ImportedFeedPanel } from '../components/ImportedFeedPanel';
import { TeamPanel } from '../components/TeamPanel';
import { CopilotPanel } from '../components/CopilotPanel';
import { EmptyState } from '../components/EmptyState';
import { SkeletonBoard, SkeletonList } from '../components/Skeleton';
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

export function BoardPage({ initial }: { initial?: { projectId: string; taskId?: string } } = {}) {
  const { user } = useAuth();
  const isClient = user?.role === 'client';
  const canManageProjects = user?.role === 'owner' || user?.role === 'manager';
  const showFinance = !isClient && MONETIZATION_ENABLED;

  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [board, dispatch] = useReducer(reducer, null);
  const [pnl, setPnl] = useState<Pnl | null>(null);
  const [cow, setCow] = useState<CostOfWork | null>(null);
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
  const [tab, setTab] = useState<'active' | 'archived'>('active');
  const [showTeam, setShowTeam] = useState(false);
  const [showCopilot, setShowCopilot] = useState(false);
  const [showFeed, setShowFeed] = useState(false);
  const [expandedConns, setExpandedConns] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('teamcrm.expandedBitrix') || '[]')); } catch { return new Set(); }
  });
  const toggleConn = (cid: string) => setExpandedConns((s) => {
    const n = new Set(s);
    if (n.has(cid)) n.delete(cid); else n.add(cid);
    localStorage.setItem('teamcrm.expandedBitrix', JSON.stringify([...n]));
    return n;
  });
  const subscribedRef = useRef<string | null>(null);
  // поле создания проекта живёт внизу сайдбара — с пустого экрана до него ведёт кнопка
  const newProjectRef = useRef<HTMLInputElement>(null);

  const reloadBoard = useCallback(() => {
    if (!selected) return;
    api.getBoard(selected).then((b) => dispatch({ type: 'SET', board: b })).catch(() => undefined);
    if (showFinance) {
      api.getPnl(selected).then(setPnl).catch(() => undefined);
      api.getProjectCostOfWork(selected).then(setCow).catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, isClient]);

  useEffect(() => {
    // тянем сразу с архивом: он лежит на отдельной вкладке, второй запрос ради счётчика не нужен
    api
      .listProjects(true)
      .then((ps) => {
        setProjects(ps);
        if (initial?.projectId && ps.some((p) => p.id === initial.projectId)) {
          setSelected(initial.projectId);
          setOpenTaskId(initial.taskId ?? null);
        } else if (!selected) setSelected(ps.find((p) => p.status !== 'archived')?.id ?? null);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Ошибка загрузки проектов'))
      .finally(() => setProjectsLoading(false));
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
      setCow(null);
      return;
    }
    setAlert(null);
    api
      .getBoard(selected)
      .then((b) => dispatch({ type: 'SET', board: b }))
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Ошибка загрузки доски'));
    if (showFinance) {
      api.getPnl(selected).then(setPnl).catch(() => setPnl(null));
      api.getProjectCostOfWork(selected).then(setCow).catch(() => setCow(null));
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
    const onPnl = (p: Pnl) => {
      if (p.projectId !== selected) return;
      setPnl(p);
      if (showFinance) api.getProjectCostOfWork(selected).then(setCow).catch(() => undefined);
    };
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

  /** Архив: проект переезжает между вкладками «Проекты» и «Архив». Данные целы. */
  const toggleArchive = async (p: Project) => {
    const archived = p.status === 'archived';
    if (!archived && !window.confirm(`Убрать проект «${p.name}» в архив? Он уйдёт на вкладку «Архив», данные сохранятся.`)) return;
    try {
      if (archived) await api.unarchiveProject(p.id); else await api.archiveProject(p.id);
      const next = await api.listProjects(true);
      setProjects(next);
      // выбранный проект уехал на другую вкладку — переводим выбор на соседний из текущей
      if (selected === p.id) {
        const stay = tab === 'archived' ? next.filter((x) => x.status === 'archived') : next.filter((x) => x.status !== 'archived');
        setSelected(stay[0]?.id ?? null);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось изменить архив');
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

  // Сайдбар: локальные проекты — верхним уровнем; импортированные (Битрикс/YouGile) — свёрнуты под узлом-источником.
  // Архив — отдельная вкладка: в работе он только мешает, но остаётся под рукой.
  const providerLabel = (origin?: string) => (origin === 'yougile' ? 'YouGile' : 'Битрикс24');
  const archivedCount = projects.filter((p) => p.status === 'archived').length;
  const shown = projects.filter((p) => (tab === 'archived' ? p.status === 'archived' : p.status !== 'archived'));
  const localProjects = shown.filter((p) => !p.origin_connection_id);
  const importedGroups: [string, { label: string; origin: string; items: Project[] }][] = [];
  {
    const byConn = new Map<string, { label: string; origin: string; items: Project[] }>();
    for (const p of shown) {
      const cid = p.origin_connection_id;
      if (!cid) continue;
      let g = byConn.get(cid);
      if (!g) { g = { label: p.origin_label || p.origin_portal || providerLabel(p.origin), origin: p.origin ?? 'bitrix', items: [] }; byConn.set(cid, g); importedGroups.push([cid, g]); }
      g.items.push(p);
    }
  }
  const renderProjectRow = (p: Project, nested = false) => (
    <div key={p.id} className={`project-row ${p.id === selected ? 'active' : ''} ${p.status === 'archived' ? 'project-archived' : ''}`} style={nested ? { paddingLeft: 18 } : undefined}>
      <button className="project-item" onClick={() => setSelected(p.id)}>
        {p.name}
        {/* значок «в архиве» не нужен: на вкладке «Архив» и так всё архивное */}
        {(p.origin === 'bitrix' || p.origin === 'yougile') && !nested && <span className="project-src" title={`Импортировано из ${providerLabel(p.origin)}`}>⤓</span>}
      </button>
      {canManageProjects && (
        <>
          <button
            className="project-del"
            title={p.status === 'archived' ? 'Вернуть из архива' : 'Убрать в архив (данные сохранятся)'}
            onClick={() => toggleArchive(p)}
          >
            <Icon name={p.status === 'archived' ? 'arrow-up' : 'archive'} size={13} />
          </button>
          <button className="project-del" title="Удалить проект" onClick={() => deleteProject(p.id, p.name)}><Icon name="close" size={13} /></button>
        </>
      )}
    </div>
  );

  return (
    <div className="board-layout">
      <aside className="sidebar">
        {archivedCount > 0 ? (
          <div className="sidebar-tabs">
            <button className={`sidebar-tab ${tab === 'active' ? 'active' : ''}`} onClick={() => setTab('active')}>
              Проекты
            </button>
            <button className={`sidebar-tab ${tab === 'archived' ? 'active' : ''}`} onClick={() => setTab('archived')} title="Проекты в архиве — данные сохранены">
              Архив <span className="sidebar-tab-count">{archivedCount}</span>
            </button>
          </div>
        ) : (
          <div className="sidebar-head">Проекты</div>
        )}
        <div className="project-list">
          {localProjects.map((p) => renderProjectRow(p))}
          {importedGroups.map(([cid, g]) => {
            const isOpen = expandedConns.has(cid);
            return (
              <div key={cid} className="project-group">
                <button
                  className="project-group-head"
                  onClick={() => toggleConn(cid)}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: '6px 8px', color: 'inherit', font: 'inherit', textAlign: 'left' }}
                  title={`Импортировано из ${providerLabel(g.origin)}: ${g.label}`}
                >
                  <span style={{ width: 10, opacity: 0.7 }}>{isOpen ? '▾' : '▸'}</span>
                  <span>⤓</span>
                  <span style={{ flex: 1, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{g.label}</span>
                  <span style={{ opacity: 0.6, fontSize: 12 }}>{g.items.length}</span>
                </button>
                {isOpen && g.items.map((p) => renderProjectRow(p, true))}
              </div>
            );
          })}
          {projectsLoading && <div className="sidebar-empty"><SkeletonList rows={5} /></div>}
          {!projectsLoading && shown.length === 0 && (
            tab === 'archived' ? (
              <EmptyState compact icon="archive" title="Архив пуст" hint="Сюда попадают проекты, которые вы завершили или отложили." />
            ) : (
              <EmptyState
                compact
                icon="folder"
                title="Пока нет проектов"
                hint={canManageProjects
                  ? 'Создайте первый проект в поле ниже или подключите доски из YouGile в разделе «Интеграции».'
                  : 'Вас пока не добавили ни в один проект. Попросите руководителя открыть доступ.'}
              />
            )
          )}
        </div>
        {canManageProjects && tab === 'active' && (
          <div className="new-project">
            <input
              ref={newProjectRef}
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
        {/* Пока проект не выбран или доска ещё едет — разные состояния, а не одна надпись:
            «выберите проект» на пустом аккаунте выглядит как тупик. */}
        {!board && (
          // при ошибке заглушку не показываем: она обещает данные, которых уже не будет
          (selected && !error) || projectsLoading ? (
            <SkeletonBoard />
          ) : projects.length === 0 ? (
            <EmptyState
              icon="board"
              title="Здесь появится доска"
              hint={canManageProjects
                ? 'Создайте проект — и сможете вести задачи по колонкам. Уже работаете в YouGile? Подключите импорт в «Интеграциях».'
                : 'Как только вас добавят в проект, его доска откроется здесь.'}
              action={canManageProjects
                ? { label: 'Создать проект', onClick: () => newProjectRef.current?.focus() }
                : undefined}
            />
          ) : (
            <EmptyState icon="arrow-left" title="Выберите проект" hint="Список проектов — слева." />
          )
        )}
        {board && (
          <>
            <div className="board-header">
              <div className="board-title">
                {board.project.name}
                <span className="view-switch" role="tablist" aria-label="Вид доски">
                  <button className={`view-btn ${view === 'board' ? 'active' : ''}`} onClick={() => switchView('board')} title="Канбан-доска"><Icon name="board" size={14} /> Доска</button>
                  <button className={`view-btn ${view === 'list' ? 'active' : ''}`} onClick={() => switchView('list')} title="Список"><Icon name="list" size={14} /> Список</button>
                </span>
                {!isClient && (
                  <span className="board-actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => setShowTeam(true)} title="Сотрудники, должности, группы, приглашения"><Icon name="users" size={15} /> Команда</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setShowCopilot(true)} title="ИИ-рекомендации по проекту"><Icon name="sparkles" size={15} /> Co-pilot</button>
                    {board.project.origin === 'bitrix' && (
                      <button className="btn btn-ghost btn-sm" onClick={() => setShowFeed(true)} title="Живая лента импортированного проекта"><Icon name="list" size={15} /> Лента</button>
                    )}
                  </span>
                )}
              </div>
              {showFinance && <PnlPanel pnl={pnl} alert={alert} cow={cow} />}
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
          columns={board?.columns.map((c) => ({ id: c.id, name: c.name })) ?? []}
          canManage={canManageProjects}
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
      {showFeed && selected && <ImportedFeedPanel projectId={selected} onClose={() => setShowFeed(false)} />}
    </div>
  );
}
