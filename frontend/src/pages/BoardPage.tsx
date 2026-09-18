import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { api, ApiError } from '../lib/api';
import { forgetProject, lastProject, rememberProject } from '../lib/last-project';
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
import { MineFilter } from '../components/MineFilter';
import { LEGACY_VIEWS, TASK_VIEWS } from '../lib/task-views';
import { ImportedFeedPanel } from '../components/ImportedFeedPanel';
import { ProjectSettingsModal } from '../components/ProjectSettingsModal';
import { EmptyState } from '../components/EmptyState';
import { NEW_PROJECT_FOCUS, PROJECTS_CHANGED } from '../components/ProjectsNav';
import { navigate } from '../lib/router';
import { useDismiss } from '../hooks/useDismiss';
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
      /*
        Событие сокета несёт СЫРУЮ строку задачи из базы — без обогащения, которое
        доска считает отдельно: меток, счётчиков комментариев и файлов, чек-листа и
        КРАСНОЙ ОТМЕТКИ «что нового».

        Подменяя карточку целиком, мы стирали всё это до перезагрузки страницы. Отсюда
        и жалоба: у проекта горит «3», а красных карточек на доске не видно — их
        отметки сдуло чужим же изменением, которое эту отметку и породило.

        Поэтому НАКЛАДЫВАЕМ пришедшее поверх известного: чего в событии нет, то
        остаётся прежним.
      */
      const prev = state.columns.flatMap((c) => c.tasks).find((x) => String(x.id) === String(t.id));
      const merged: Task = prev ? { ...prev, ...t } : t;
      const columns: BoardColumn[] = state.columns.map((c) => ({
        ...c,
        tasks: c.tasks.filter((x) => x.id !== t.id),
      }));
      const target = columns.find((c) => c.id === merged.column_id);
      if (target) {
        target.tasks.push(merged);
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

export function BoardPage({ initial, onNavigate, onVoiceTask }: {
  initial?: { projectId: string; taskId?: string };
  /** Сообщает наверх, что показано сейчас, — чтобы адрес в строке браузера совпадал с экраном. */
  onNavigate?: (projectId: string | null, taskId: string | null) => void;
  /** Продиктовать задачу: окно живёт в приложении, доска только просит его открыть. */
  onVoiceTask?: () => void;
} = {}) {
  const { user } = useAuth();
  const isClient = user?.role === 'client';
  /*
    Два разных права, а не одно.

    Раньше всё управление доской пряталось за «владелец или руководитель», и сотрудник
    не видел ни стрелок переноса колонок, ни архивации проекта — кнопки просто не
    рисовались, и понять, почему у коллеги они есть, а у тебя нет, было невозможно.

    Доской управляют все, кто по ней работает: порядок и названия колонок, добавление,
    архив, создание и удаление проекта, удаление задач и ИИ-агент в карточке. От
    случайного нажатия удерживает подтверждение, а не роль.

    Клиент сюда не попадает вовсе — у него свой портал.
  */
  const canManageBoard = !isClient;
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
    const saved = localStorage.getItem('teamcrm.boardMine') ?? '';
    if (saved === 'both' || TASK_VIEWS.some((v) => v.key === saved)) return saved as MineMode;
    // прежние названия срезов: у людей они лежат в памяти браузера со вчерашнего дня
    if (LEGACY_VIEWS[saved]) return LEGACY_VIEWS[saved];
    return saved === '1' ? 'doing' : 'off'; // самая старая настройка «Мои задачи» = назначенные
  });
  /** Постановщик из списка: работает независимо от «моих» — что человек раздал кому угодно. */
  const [creatorId, setCreatorId] = useState<string>('');
  /** «Только в работе»: скрыть завершённые карточки. По умолчанию выключено — см. MineFilter. */
  const [inWorkOnly, setInWorkOnly] = useState(() => localStorage.getItem('teamcrm.boardInWork') === '1');


  /*
    Кнопки «Команда» на доске больше нет.

    Она висела у КАЖДОГО, кроме клиента, хотя заводить и менять сотрудников вправе
    только руководитель и его зам — рядовой сотрудник открывал панель и упирался в
    отказы сервера. Управление командой живёт в личном кабинете, где карточка
    «Команда и пространство» и так показана только этим двум ролям.
  */
  /** Настройки проекта: место доски в списке и порядок досок компании. */
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  /** Переключатель досок в названии проекта: открыт ли и что набрали в поиске. */
  const [switchOpen, setSwitchOpen] = useState(false);
  const [switchQuery, setSwitchQuery] = useState('');
  // Щелчок мимо списка досок и Esc закрывают его: без этого он висел до перезагрузки.
  const closeSwitch = useCallback(() => setSwitchOpen(false), []);
  useDismiss(switchOpen, closeSwitch, '.board-switch-btn');
  const [showFeed, setShowFeed] = useState(false);
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

  /*
    Запоминаем выбор при каждой смене — одним местом на все пути: клик по проекту,
    переход из «Моих задач», удаление и архивация соседнего.

    Память общая с разделом «Проекты и доски» (см. lib/last-project) и живёт сутки:
    возвращать человека в проект, который он бросил неделю назад, — решать за него.
  */
  useEffect(() => {
    rememberProject(user?.tenantId, selected);
  }, [selected, user?.tenantId]);

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
          const savedId = lastProject(user?.tenantId);
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
      const opts = { userId: String(user?.id ?? ''), mode: mineMode, creatorId: creatorId || null, inWorkOnly };
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
    [board, selected, mineMode, creatorId, inWorkOnly, user],
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
  const filterOpts = { userId: String(user?.id ?? ''), mode: mineMode, creatorId: creatorId || null, inWorkOnly };
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
              hint={canManageBoard
                ? 'Создайте проект — и сможете вести задачи по колонкам. Уже работаете в YouGile? Подключите импорт в «Интеграциях».'
                : 'Как только вас добавят в проект, его доска откроется здесь.'}
              action={canManageBoard
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
                {/*
                  Название проекта — переключатель досок.

                  Список проектов ушёл из левой панели, и перескакивать между досками
                  надо оттуда, где ты уже находишься: нажал на название — выбрал другой
                  проект. «Все проекты» уводит в таблицу со всеми досками.
                */}
                <span className="board-switch">
                  <button
                    className="board-switch-btn"
                    onClick={() => setSwitchOpen((v) => !v)}
                    aria-expanded={switchOpen}
                    title="Перейти к другому проекту"
                  >
                    {board.project.name}
                    <Icon name="chevron-down" size={14} />
                  </button>
                  {switchOpen && (
                    <span className="chat-pop board-switch-pop" data-pop>
                      <input
                        className="input"
                        value={switchQuery}
                        onChange={(e) => setSwitchQuery(e.target.value)}
                        placeholder="Поиск проекта"
                        aria-label="Поиск проекта"
                        autoFocus
                      />
                      {projects
                        .filter((p) => p.status !== 'archived')
                        .filter((p) => p.name.toLowerCase().includes(switchQuery.trim().toLowerCase()))
                        .slice(0, 12)
                        .map((p) => (
                          <button
                            key={p.id}
                            className={`chat-pop-row${String(p.id) === String(selected) ? ' active' : ''}`}
                            onClick={() => { setSwitchOpen(false); setSwitchQuery(''); setSelected(String(p.id)); setOpenTaskId(null); }}
                          >
                            <Icon name="board" size={13} /> {p.name}
                            {!!p.unread && <span className="badge badge-info">{p.unread}</span>}
                          </button>
                        ))}
                      <button
                        className="chat-pop-row board-switch-all"
                        onClick={() => { setSwitchOpen(false); forgetProject(); navigate({ section: 'projects' }); }}
                      >
                        <Icon name="list" size={13} /> Все проекты
                      </button>
                    </span>
                  )}
                </span>
                <span className="view-switch" role="tablist" aria-label="Вид доски">
                  <button className={`view-btn ${view === 'board' ? 'active' : ''}`} onClick={() => switchView('board')} title="Канбан-доска"><Icon name="board" size={14} /> Доска</button>
                  <button className={`view-btn ${view === 'list' ? 'active' : ''}`} onClick={() => switchView('list')} title="Список"><Icon name="list" size={14} /> Список</button>
                </span>
                {!isClient && (
                  /* Один фильтр вместо трёх элементов: «чьи задачи» — один вопрос,
                     и в шапке доски ему хватает одной кнопки с выпадающим списком. */
                  <MineFilter
                    mode={mineMode}
                    creatorId={creatorId}
                    creators={creators}
                    count={shownCount}
                    inWorkOnly={inWorkOnly}
                    onChange={({ mode, creatorId: creator, inWorkOnly: onlyWork }) => {
                      setMineMode(mode);
                      setCreatorId(creator);
                      setInWorkOnly(onlyWork);
                      localStorage.setItem('teamcrm.boardMine', mode);
                      localStorage.setItem('teamcrm.boardInWork', onlyWork ? '1' : '0');
                    }}
                  />
                )}
                {!isClient && (
                  <span className="board-actions">
                    {/*
                      Постановка задачи — здесь, а не в левой панели.

                      Заказчик перенёс её туда, где задачи и живут. Текстом — обычная
                      форма в первую колонку доски (с файлами и проверкой дублей);
                      голосом — то же окно диктовки, что и раньше, с этим проектом.
                    */}
                    {board.columns.length > 0 && (
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => openCreate(board.columns[0].id)}
                        title={`Новая задача в колонку «${board.columns[0].name}» (клавиша C — голосом или текстом)`}
                      >
                        <Icon name="plus" size={15} /> Новая задача
                      </button>
                    )}
                    {onVoiceTask && (
                      <button
                        className="btn btn-primary btn-sm board-mic"
                        onClick={onVoiceTask}
                        title="Продиктовать задачу голосом"
                        aria-label="Продиктовать задачу голосом"
                      >
                        <Icon name="mic" size={15} />
                      </button>
                    )}
                    {/* Настройки самой доски: место в списке и порядок досок компании.
                        Раньше это висело кнопкой в левой панели — не её дело. */}
                    {canManageBoard && (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => setShowProjectSettings(true)}
                        title="Настройки проекта: место в списке досок"
                      >
                        <Icon name="settings" size={15} /> Настройки
                      </button>
                    )}
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
                title={mineMode === 'delegated' ? 'В этом проекте вы ничего не поручали'
                  : mineMode === 'doing' ? 'В этом проекте на вас ничего не назначено'
                    : mineMode === 'helping' ? 'В этом проекте вы никому не помогаете'
                      : mineMode === 'watching' ? 'В этом проекте вы ни за чем не наблюдаете'
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
                    canManage={canManageBoard}
                    canDelete={canManageBoard}
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
                {canManageBoard && (
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
          /* Ключ по задаче: карточка держит правки в своём состоянии, и при переходе
             к другой задаче (из чата, из поиска) они обязаны обнулиться, а не переехать
             в чужую карточку. */
          key={openTask.id}
          task={openTask}
          users={users}
          columns={board?.columns.map((c) => ({ id: c.id, name: c.name })) ?? []}
          canDelete={canManageBoard}
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
      {showProjectSettings && board && (
        <ProjectSettingsModal
          project={board.project as any}
          onClose={() => setShowProjectSettings(false)}
          onChanged={reloadBoard}
        />
      )}
      {showFeed && selected && <ImportedFeedPanel projectId={selected} onClose={() => setShowFeed(false)} />}
    </div>
  );
}
