import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { api, ApiError } from '../lib/api';
import { getSocket } from '../lib/socket';
import { useAuth } from '../state/auth';
import type { Board, BoardColumn, CostOfWork, Pnl, Project, Task, User } from '../types';
import { ColumnView } from '../components/ColumnView';
import { PnlPanel } from '../components/PnlPanel';
import { TaskDrawer } from '../components/TaskDrawer';
import { GateBlock, HandoffGateDialog, gateFromError } from '../components/HandoffGateDialog';
import { TaskCreateModal } from '../components/TaskCreateModal';
import { TaskListView } from '../components/TaskListView';
import {
  countMatching, filterActive, filterBoard, MineMode, realPosition,
} from '../lib/board-filter';
import { ImportedFeedPanel } from '../components/ImportedFeedPanel';
import { TeamPanel } from '../components/TeamPanel';
import { CopilotPanel } from '../components/CopilotPanel';
import { EmptyState } from '../components/EmptyState';
import { NEW_PROJECT_FOCUS, PROJECTS_CHANGED } from '../components/ProjectsNav';
import { SkeletonBoard } from '../components/Skeleton';
import { MONETIZATION_ENABLED } from '../config';

type Action =
  | { type: 'SET'; board: Board }
  | { type: 'CLEAR' }
  | { type: 'UPSERT_TASK'; task: Task }
  | { type: 'REMOVE_TASK'; taskId: string }
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
    case 'REMOVE_TASK': {
      const columns = state.columns.map((c) => ({ ...c, tasks: c.tasks.filter((t) => String(t.id) !== String(action.taskId)) }));
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

export function BoardPage({ initial, onNavigate }: {
  initial?: { projectId: string; taskId?: string };
  /** Сообщает наверх, что показано сейчас, — чтобы адрес в строке браузера совпадал с экраном. */
  onNavigate?: (projectId: string | null, taskId: string | null) => void;
} = {}) {
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
  const [users, setUsers] = useState<User[]>([]);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  // задача сдаётся не полностью: помним, что именно человек пытался сделать,
  // чтобы «Сдать всё равно» повторило ровно тот же перенос
  const [gate, setGate] = useState<{ block: GateBlock; taskId: string; columnId: string; position: number } | null>(null);
  const [createIn, setCreateIn] = useState<{ columnId: string; columnName: string } | null>(null);
  const [view, setView] = useState<'board' | 'list'>(() =>
    localStorage.getItem('teamcrm.boardView') === 'list' ? 'list' : 'board',
  );
  const switchView = (v: 'board' | 'list') => { setView(v); localStorage.setItem('teamcrm.boardView', v); };
  /**
   * Чьи задачи показывать — фильтр, а не отдельный вид: человек остаётся там, где
   * работал, и просто перестаёт видеть чужое. На доске это доска, в списке — список.
   *
   * «Назначены мне» и «Поставлены мной» разделены намеренно: это разные роли в работе.
   * Первое — что мне делать, второе — что я жду от других и с чего спрошу.
   */
  const [mineMode, setMineMode] = useState<MineMode>(() => {
    const saved = localStorage.getItem('teamcrm.boardMine');
    if (saved === 'assigned' || saved === 'created' || saved === 'both') return saved;
    return saved === '1' ? 'assigned' : 'off'; // старая настройка «Мои задачи» = назначенные
  });
  /** Постановщик из списка: работает независимо от «моих» — что человек раздал кому угодно. */
  const [creatorId, setCreatorId] = useState<string>('');

  /**
   * Кнопки ролей — независимые тумблеры, а не радиокнопки.
   *
   * Нажатые вместе они дают «моя работа целиком»: и то, что я делаю, и то, что жду
   * от других. Повторный клик по активной снимает её — как сворачивание разделов
   * в меню. Так один переключатель отвечает на три разных вопроса без третьей кнопки.
   */
  const toggleRole = (role: 'assigned' | 'created') => {
    const on = mineMode === role || mineMode === 'both';
    const other = role === 'assigned' ? 'created' : 'assigned';
    const otherOn = mineMode === other || mineMode === 'both';
    const value: MineMode = on
      ? (otherOn ? other : 'off')
      : (otherOn ? 'both' : role);
    setMineMode(value);
    localStorage.setItem('teamcrm.boardMine', value);
  };
  const roleOn = (role: 'assigned' | 'created') => mineMode === role || mineMode === 'both';
  const [showTeam, setShowTeam] = useState(false);
  const [showCopilot, setShowCopilot] = useState(false);
  const [showFeed, setShowFeed] = useState(false);
  // Ключ памяти о проекте — свой на каждую организацию: при переключении
  // компании возврат должен вести в её проект, а не в чужой.
  const lastProjectKey = `teamcrm.lastProject.${user?.tenantId ?? 'anon'}`;
  const subscribedRef = useRef<string | null>(null);
  // поле создания проекта живёт внизу сайдбара — с пустого экрана до него ведёт кнопка

  const reloadBoard = useCallback(() => {
    if (!selected) return;
    api.getBoard(selected).then((b) => dispatch({ type: 'SET', board: b })).catch(() => undefined);
    if (showFinance) {
      api.getPnl(selected).then(setPnl).catch(() => undefined);
      api.getProjectCostOfWork(selected).then(setCow).catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, isClient]);

  // Запоминаем выбор при каждой смене — одним местом на все пути:
  // клик по проекту, переход из «Моих задач», удаление и архивация соседнего.
  useEffect(() => {
    if (selected) localStorage.setItem(lastProjectKey, String(selected));
  }, [selected, lastProjectKey]);

  // Адрес догоняет экран: открытый проект и карточка видны в строке браузера,
  // поэтому ссылку на задачу можно просто скопировать и отправить.
  // До загрузки списка проектов молчим: там выбранного ещё нет, и адрес с задачей
  // успел бы схлопнуться до «/projects» прямо на глазах у человека.
  useEffect(() => {
    if (projectsLoading) return;
    onNavigate?.(selected, openTaskId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, openTaskId, projectsLoading]);

  // Проекты создают, архивируют и удаляют теперь в меню слева — доска обязана
  // об этом узнать, иначе её заголовок и выбор живут в прошлом до перезагрузки.
  useEffect(() => {
    const refresh = () => api.listProjects(true).then(setProjects).catch(() => undefined);
    window.addEventListener(PROJECTS_CHANGED, refresh);
    return () => window.removeEventListener(PROJECTS_CHANGED, refresh);
  }, []);

  useEffect(() => {
    // тянем сразу с архивом: он лежит на отдельной вкладке, второй запрос ради счётчика не нужен
    api
      .listProjects(true)
      .then((ps) => {
        setProjects(ps);
        if (initial?.projectId && ps.some((p) => p.id === initial.projectId)) {
          setSelected(initial.projectId);
          setOpenTaskId(initial.taskId ?? null);
        } else if (!selected) {
          // после F5 возвращаемся в последний открытый проект, а не в начало списка;
          // если его больше нет (удалён, сменилась организация) — первый активный
          const savedId = localStorage.getItem(lastProjectKey);
          const restored = savedId ? ps.find((p) => String(p.id) === savedId) : undefined;
          const pick = restored ?? ps.find((p) => p.status !== 'archived') ?? null;
          setSelected(pick?.id ?? null);
        }
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
    const onDeleted = (p: { id: string; project_id: string }) => {
      if (String(p.project_id) !== String(selected)) return;
      dispatch({ type: 'REMOVE_TASK', taskId: String(p.id) });
      setOpenTaskId((cur) => (String(cur) === String(p.id) ? null : cur)); // карточку удалённой задачи держать открытой нельзя
    };
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
    socket.on('task.deleted', onDeleted);
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
      socket.off('task.deleted', onDeleted);
      socket.off('task.cost_changed', onCost);
      socket.off('project.pnl_changed', onPnl);
      socket.off('alert.raised', onAlert);
      socket.off('alert.resolved', onAlertResolved);
      socket.off('column.updated', onColumns);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);




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
    async (taskId: string, columnId: string, visibleIndex: number, confirmGate = false) => {
      const current = board?.columns.flatMap((c) => c.tasks).find((t) => t.id === taskId);
      // Перетаскивание сообщает место среди ВИДИМЫХ карточек. При включённом фильтре
      // это не настоящая позиция: между двумя своими задачами могут стоять чужие,
      // и без пересчёта задача уехала бы в начало колонки.
      const target = board?.columns.find((c) => c.id === columnId);
      const opts = { userId: String(user?.id ?? ''), mode: mineMode, creatorId: creatorId || null };
      const position = user && target && filterActive(opts)
        ? realPosition(target.tasks, opts, visibleIndex)
        : visibleIndex;
      if (current) dispatch({ type: 'UPSERT_TASK', task: { ...current, column_id: columnId, position } });
      try {
        const server = await api.moveTask(taskId, { columnId, position, confirmGate });
        dispatch({ type: 'UPSERT_TASK', task: server });
        setGate(null);
      } catch (e) {
        // приёмка работы: не ошибка, а вопрос — показываем, чего не хватает, и даём решить
        const block = e instanceof ApiError ? gateFromError(e.details) : null;
        if (block) setGate({ block, taskId, columnId, position });
        else setError(e instanceof ApiError ? e.message : 'Не удалось перенести задачу');
        // карточка уже уехала оптимистично — возвращаем доску к тому, что на сервере
        if (selected) api.getBoard(selected).then((b) => dispatch({ type: 'SET', board: b }));
      }
    },
    [board, selected, mineMode, creatorId, user],
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
  // число рядом с «Моими задачами»: видно, есть ли по проекту работа лично на мне,
  // не переключаясь на эту вкладку
  const filterOpts = { userId: String(user?.id ?? ''), mode: mineMode, creatorId: creatorId || null };
  /**
   * Кто вообще ставил задачи в этом проекте.
   *
   * Список строим по доске, а не по всей команде: выбирать из тридцати человек,
   * двадцать восемь из которых сюда ничего не ставили, — значит гарантированно
   * нарваться на пустой экран.
   */
  const creators = board
    ? [...new Map(board.columns.flatMap((c) => c.tasks)
      .filter((t) => t.created_by)
      .map((t) => [String(t.created_by), t.manager_name
        ?? users.find((u) => String(u.id) === String(t.created_by))?.fullName ?? 'Без имени']))
      .entries()].sort((a, b) => a[1].localeCompare(b[1], 'ru'))
    : [];
  const shownCount = board && user ? countMatching(board.columns, filterOpts) : 0;
  // Доске оставляем все колонки даже пустыми — иначе бросать задачу становится некуда;
  // в списке пустые заголовки только мешают.
  // Проект сменился, а выбранный постановщик в нём ничего не ставил — снимаем выбор,
  // иначе человек видит пустую доску и не понимает, почему.
  useEffect(() => {
    if (creatorId && board && !creators.some(([id]) => id === creatorId)) setCreatorId('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, board?.columns.length]);

  const shownBoard = board && user && filterActive(filterOpts)
    ? { ...board, columns: filterBoard(board.columns, filterOpts, view === 'board') }
    : board;


  return (
    <div className="board-layout">

      <main className="board-main">
        {error && <div className="error-text board-error">{error}</div>}
        {gate && (
          <HandoffGateDialog
            block={gate.block}
            onCancel={() => setGate(null)}
            onForce={() => moveTask(gate.taskId, gate.columnId, gate.position, true)}
          />
        )}
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
                // поле создания живёт в меню слева — просим его принять курсор
                ? { label: 'Создать проект', onClick: () => window.dispatchEvent(new Event(NEW_PROJECT_FOCUS)) }
                : undefined}
            />
          ) : (
            <EmptyState icon="arrow-left" title="Выберите проект" hint="Список проектов — в меню слева, под разделом «Проекты и доски»." />
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
                  /* Две роли — две кнопки-тумблера. «Мои задачи» одной кнопкой смешивали
                     «что мне делать» и «что я жду от других»; на доске это разные вопросы.
                     Нажатые вместе кнопки дают прежнее «всё моё», нажатие на активную
                     снимает её — как сворачивание разделов в меню. */
                  <span className="mine-switch" role="group" aria-label="Чьи задачи показывать">
                    <button
                      className={`view-btn mine-toggle ${roleOn('assigned') ? 'active' : ''}`}
                      onClick={() => toggleRole('assigned')}
                      aria-pressed={roleOn('assigned')}
                      title="Задачи, где исполнитель — вы"
                    >
                      <Icon name="user" size={14} /> Назначены мне
                    </button>
                    <button
                      className={`view-btn mine-toggle ${roleOn('created') ? 'active' : ''}`}
                      onClick={() => toggleRole('created')}
                      aria-pressed={roleOn('created')}
                      title="Задачи, которые поставили вы — кому бы то ни было"
                    >
                      <Icon name="send" size={14} /> Поставлены мной
                    </button>
                    {/* Постановщик отдельным списком: он про чужие раздачи, а не про мои,
                        и сужает выбор вместе с кнопками, а не вместо них. */}
                    <select
                      className="input mine-creator"
                      value={creatorId}
                      onChange={(e) => setCreatorId(e.target.value)}
                      title="Показать задачи, поставленные конкретным человеком"
                      aria-label="Постановщик"
                    >
                      <option value="">Постановщик: любой</option>
                      {creators.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                    </select>
                    {filterActive(filterOpts) && <span className="view-count">{shownCount}</span>}
                  </span>
                )}
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
            {filterActive(filterOpts) && shownCount === 0 ? (
              <EmptyState
                icon="user"
                title={mineMode === 'created' ? 'В этом проекте вы ничего не поручали'
                  : mineMode === 'assigned' ? 'В этом проекте на вас ничего не назначено'
                    : 'Под выбранный фильтр ничего не подходит'}
                hint="Снимите фильтр, чтобы увидеть работу всей команды."
              />
            ) : view === 'list' ? (
              <TaskListView
                board={shownBoard!}
                users={users}
                activeTimerTask={activeTimerTask}
                onOpenTask={(t) => setOpenTaskId(t.id)}
              />
            ) : (
              <div className="board-columns">
                {(shownBoard ?? board).columns.map((col, idx) => (
                  <ColumnView
                    key={col.id}
                    column={col}
                    users={users}
                    canEdit={!isClient}
                    canManage={canManageProjects}
                    isFirst={idx === 0}
                    isLast={idx === board.columns.length - 1}
                    activeTimerTask={activeTimerTask}
                    onRequestAddTask={openCreate}
                    onMoveTask={moveTask}
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
