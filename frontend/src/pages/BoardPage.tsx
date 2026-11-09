import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { api, ApiError } from '../lib/api';
import { forgetProject, lastProject, rememberProject } from '../lib/last-project';
import { getSocket } from '../lib/socket';
import { useAuth } from '../state/auth';
import type { Board, BoardColumn, CostOfWork, Pnl, Project, Task, User } from '../types';
import { ColumnView } from '../components/ColumnView';
import { PnlPanel } from '../components/PnlPanel';
import { lazyComponent, preloadWhenIdle } from '../lib/lazy';
import { FavoriteStar } from '../components/FavoriteStar';
const ProjectSettingsModal = lazyComponent(() => import('../components/ProjectSettingsModal').then((m) => m.ProjectSettingsModal));
import { GateBlock, HandoffGateDialog, gateFromError } from '../components/HandoffGateDialog';
import { TaskListView } from '../components/TaskListView';
import {
  countMatching, filterActive, filterBoard, PAUSED_STAGES, QuickKey, realPosition, REVIEW_STAGES,
} from '../lib/board-filter';
import { takeDraftOpen, TASK_DRAFT_OPEN, type TaskDraft } from '../lib/task-draft';
import { BoardQuery, loadQuery, normalize, QUICK, saveQuery, toFilter } from '../lib/board-query';
import { commonLabels } from '../lib/board-card';
import { BoardBar } from '../components/board/BoardBar';
import { ViewsMenu } from '../components/board/ViewsMenu';
import { DropdownMenu, MenuItem, MenuSeparator } from '../components/ui/dropdown-menu';
import { flowApi } from '../lib/flow-api';
import { showToast } from '../lib/notifications';
import { useIsPhone } from '../hooks/useMediaQuery';
import { ImportedFeedPanel } from '../components/ImportedFeedPanel';
import { EmptyState } from '../components/EmptyState';
import { CareEmpty } from '../components/care';
import { useDragEdgeScroll } from '../hooks/useDragEdgeScroll';
import { NEW_PROJECT_FOCUS, PROJECTS_CHANGED } from '../components/ProjectsNav';
import { navigate } from '../lib/router';
import { useDismiss } from '../hooks/useDismiss';
import { SYNC_EVENT, syncTouches, type SyncDetail } from '../hooks/useDeltaSync';
import { SkeletonBoard } from '../components/Skeleton';
import { MONETIZATION_ENABLED } from '../config';
import { Button } from '../components/ui/button';
import { confirmAction, promptText } from '../components/ui/dialog';
import { useTitleHint } from '../lib/page-title';
import { feedback } from '../lib/feedback';

/*
  Карточка задачи (с чатом, редактором описания, вкладками) и окно создания грузятся
  отдельно от доски: доска показывается сразу, а карточка подтягивается в фоне, пока
  человек смотрит на колонки, — к первому нажатию она уже на месте.
*/
const TaskDrawer = lazyComponent(() => import('../components/TaskDrawer').then((m) => m.TaskDrawer));
const TaskCreateModal = lazyComponent(() => import('../components/TaskCreateModal').then((m) => m.TaskCreateModal));
/* Инфоцентр проекта (#4659): нулевая колонка — своим куском, первый экран не тяжелеет. */
const HubColumn = lazyComponent(() => import('../components/hub/HubColumn').then((m) => m.HubColumn));
/* #4798/#4799: очередь решений, сдача результата и правила — окна, которые открывают не каждый день. */
const ReviewQueue = lazyComponent(() => import('../components/review/ReviewQueue').then((m) => m.ReviewQueue));
const HandoffDialog = lazyComponent(() => import('../components/task-flow/HandoffDialog').then((m) => m.HandoffDialog));
const RulesDialog = lazyComponent(() => import('../components/board/RulesDialog').then((m) => m.RulesDialog));

/** Личный вид доски: ширина колонок, плотность карточек, свёрнутые колонки (#4798 §14, §20). */
interface BoardUi { w: 'narrow' | 'normal' | 'wide'; detail: boolean; col: Record<string, string[]>; sort: BoardSort }
/** Порядок карточек в колонке (#4798 §14): вручную (как перетащили) или по признаку — только показ. */
type BoardSort = 'manual' | 'deadline' | 'priority' | 'updated';
const SORTS: { key: BoardSort; label: string }[] = [
  { key: 'manual', label: 'Порядок: как расставили' },
  { key: 'deadline', label: 'Порядок: по сроку' },
  { key: 'priority', label: 'Порядок: по приоритету' },
  { key: 'updated', label: 'Порядок: недавно изменённые сверху' },
];
const PRIO_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
function sortTasks(tasks: Task[], sort: BoardSort): Task[] {
  if (sort === 'manual') return tasks;
  const time = (s?: string | null) => (s ? new Date(s).getTime() : Number.POSITIVE_INFINITY);
  const by: Record<Exclude<BoardSort, 'manual'>, (a: Task, b: Task) => number> = {
    deadline: (a, b) => time(a.deadline_at) - time(b.deadline_at),
    priority: (a, b) => (PRIO_RANK[a.priority ?? 'normal'] ?? 2) - (PRIO_RANK[b.priority ?? 'normal'] ?? 2) || time(a.deadline_at) - time(b.deadline_at),
    // свежие сверху, задачи без событий — внизу
    updated: (a, b) => (b.last_activity_at ? new Date(b.last_activity_at).getTime() : 0) - (a.last_activity_at ? new Date(a.last_activity_at).getTime() : 0),
  };
  return [...tasks].sort(by[sort]);
}
const uiKey = (uid: string) => `qevo.board.ui:${uid}`;
function readUi(uid: string): BoardUi {
  try {
    const s = JSON.parse(localStorage.getItem(uiKey(uid)) ?? '{}') as Partial<BoardUi>;
    const sort = SORTS.some((x) => x.key === s.sort) ? s.sort! : 'manual';
    // #4807 §4: по умолчанию компактные карточки; «Подробно» — выбор человека
    return { w: s.w === 'narrow' || s.w === 'wide' ? s.w : 'normal', detail: !!s.detail, col: s.col ?? {}, sort };
  } catch { return { w: 'normal', detail: false, col: {}, sort: 'manual' }; }
}
/** #4807 §3: «Готово» и «В планах» свёрнуты, пока человек сам не развернёт (выбор запоминается). */
function defaultCollapsed(columns: { id: string; name: string; stage_type?: string | null }[]): string[] {
  return columns.filter((c) => c.stage_type === 'done' || /^в планах/i.test(c.name.trim())).map((c) => String(c.id));
}
function writeUi(uid: string, ui: BoardUi) {
  try { localStorage.setItem(uiKey(uid), JSON.stringify(ui)); } catch { /* без хранилища — до перезагрузки */ }
}

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

/*
  #4794: при каждом заходе в «Проекты и Задачи» доска рисовала серые заглушки:
  приложение пересобирает её при смене адреса извне, и она заново ждала сначала
  список проектов, потом саму доску — два запроса подряд. Последние список и доски
  живут в памяти вкладки: доска встаёт сразу, свежие данные подменяют её следом.
*/
let projectsSeen: Project[] | null = null;
const boardsSeen = new Map<string, Board>();
/** Чья это память: выход и вход другим человеком страницу не перезагружают. */
let seenBy: string | undefined;
function ownSeen(userId: string | undefined): void {
  if (seenBy === userId) return;
  seenBy = userId; projectsSeen = null; boardsSeen.clear();
}

/** Какой проект открыть по уже известному списку — то же правило, что после загрузки. */
function pickProject(ps: Project[], initialId: string | undefined, tenantId: string | undefined): string | null {
  if (initialId && ps.some((p) => p.id === initialId)) return initialId;
  const savedId = lastProject(tenantId);
  const restored = savedId ? ps.find((p) => String(p.id) === savedId) : undefined;
  return (restored ?? ps.find((p) => p.status !== 'archived') ?? null)?.id ?? null;
}

export function BoardPage({ initial, onNavigate, onVoiceTask }: {
  initial?: { projectId: string; taskId?: string };
  /** Сообщает наверх, что показано сейчас, — чтобы адрес в строке браузера совпадал с экраном. */
  onNavigate?: (projectId: string | null, taskId: string | null) => void;
  /** Продиктовать задачу: окно живёт в приложении, доска только просит его открыть. */
  onVoiceTask?: () => void;
} = {}) {
  // Доска нарисована — подтягиваем карточку и окно создания, пока человек смотрит на колонки.
  useEffect(() => { preloadWhenIdle(TaskDrawer, TaskCreateModal); }, []);
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

  ownSeen(user?.id);
  const [projects, setProjects] = useState<Project[]>(() => projectsSeen ?? []);
  const [projectsLoading, setProjectsLoading] = useState(() => !projectsSeen);
  const [selected, setSelected] = useState<string | null>(() =>
    projectsSeen ? pickProject(projectsSeen, initial?.projectId, user?.tenantId) : null);
  const [board, dispatch] = useReducer(reducer, null, () => (selected ? boardsSeen.get(selected) ?? null : null));
  useEffect(() => { if (board?.project?.id) boardsSeen.set(String(board.project.id), board); }, [board]);
  useEffect(() => { if (!projectsLoading) projectsSeen = projects; }, [projects, projectsLoading]);
  useTitleHint(board?.project ? `project:${board.project.id}` : null, board?.project?.name);
  const [pnl, setPnl] = useState<Pnl | null>(null);
  const [cow, setCow] = useState<CostOfWork | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const [activeTimerTask, setActiveTimerTask] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [users, setUsers] = useState<User[]>([]);
  const [openTaskId, setOpenTaskId] = useState<string | null>(() =>
    projectsSeen && initial?.projectId && selected === initial.projectId ? initial.taskId ?? null : null);
  // задача сдаётся не полностью: помним, что именно человек пытался сделать,
  // чтобы «Сдать всё равно» повторило ровно тот же перенос
  const [gate, setGate] = useState<{ block: GateBlock; taskId: string; columnId: string; position: number } | null>(null);
  const [createIn, setCreateIn] = useState<{ columnId: string; columnName: string; draft?: TaskDraft } | null>(null);
  /*
    Лента колонок: к ней привязано автоматическое движение при переносе карточки к краю
    экрана — иначе до колонки, которой не видно, задачу не донести.
  */
  const columnsRef = useRef<HTMLDivElement>(null);

  const [view, setView] = useState<'board' | 'list'>(() =>
    localStorage.getItem('teamcrm.boardView') === 'list' ? 'list' : 'board',
  );
  const switchView = (v: 'board' | 'list') => { setView(v); localStorage.setItem('teamcrm.boardView', v); };
  useDragEdgeScroll(columnsRef, view === 'board');
  const { organizations } = useAuth();
  const uid = String(user?.id ?? '');
  const [ui, setUiState] = useState<BoardUi>(() => readUi(uid));
  const setUi = (patch: Partial<BoardUi>) => setUiState((cur) => { const next = { ...cur, ...patch }; writeUi(uid, next); return next; });
  /**
   * Чьи задачи показывать — фильтр, а не отдельный вид: человек остаётся там, где
   * работал, и просто перестаёт видеть чужое. На доске это доска, в списке — список.
   *
   * «Назначены мне» и «Поставлены мной» разделены намеренно: это разные роли в работе.
   * Первое — что мне делать, второе — что я жду от других и с чего спрошу.
   */
  /*
    Что показывает доска (#4799 §3): режим, роли (ИЛИ), быстрые условия (И), фильтры и
    поиск по доске — одним объектом, на человека, компанию и проект (lib/board-query).
  */
  const [query, setQueryState] = useState<BoardQuery>(() => loadQuery(user?.tenantId, user?.id, selected));
  /** Открытый сохранённый вид — его имя на кнопке «Виды», пока условия не меняли. */
  const [activeView, setActiveView] = useState<string | null>(null);
  const setQuery = useCallback((q: BoardQuery) => {
    const n = normalize(q);
    setQueryState(n);
    setActiveView(null);
    saveQuery(user?.tenantId, user?.id, selected, n);
  }, [user?.tenantId, user?.id, selected]);
  useEffect(() => { setQueryState(loadQuery(user?.tenantId, user?.id, selected)); setActiveView(null); }, [selected, user?.tenantId, user?.id]);
  /** Ссылка на сохранённый вид (?view=12) — откроем, когда загрузится доска. */
  const pendingView = useRef<string | null>(new URLSearchParams(window.location.search).get('view'));
  /** Сообщение о том, что часть условий снята: доступ или состав доски изменились. */
  const [accessNote, setAccessNote] = useState('');
  const [reviewOpen, setReviewOpen] = useState(false);
  const phone = useIsPhone();
  /** Инфоцентр — по кнопке «Инфоцентр проекта» (макет 01), открыт ли — помним на проект. */
  const hubKey = selected ? `qevo.board.hub:${uid}:${selected}` : '';
  const [hubOpenState, setHubOpenState] = useState<{ key: string; open: boolean } | null>(null);
  const hubOpen = hubOpenState?.key === hubKey ? hubOpenState.open : (() => { try { return localStorage.getItem(hubKey) === '1'; } catch { return false; } })();
  const setHubOpen = (v: boolean) => { setHubOpenState({ key: hubKey, open: v }); try { localStorage.setItem(hubKey, v ? '1' : '0'); } catch { /* без хранилища */ } };
  /** Какие колонки сейчас видны — подсветка в ряду этапов. */
  const [visibleCols, setVisibleCols] = useState<Set<string>>(new Set());
  const [rulesOpen, setRulesOpen] = useState(false);
  /** Сдача результата при переносе в колонку проверки (#4799 BOARD03). */
  const [handoff, setHandoff] = useState<{ task: Task; columnId: string; columnName: string; position: number } | null>(null);
  /** «Отменить» ошибочный перенос (#4798 §20): несколько секунд после переноса. */
  const [undo, setUndo] = useState<{ taskId: string; title: string; to: string; fromColumn: string; fromPosition: number } | null>(null);
  useEffect(() => {
    if (!undo) return;
    const t = window.setTimeout(() => setUndo(null), 8000);
    return () => window.clearTimeout(t);
  }, [undo]);


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
  /** #4829: список открывается под той кнопкой, которой его вызвали, — по её левому краю. */
  const [switchFrom, setSwitchFrom] = useState<'name' | 'all'>('all');
  const toggleSwitch = (from: 'name' | 'all') => {
    setSwitchFrom(from);
    setSwitchOpen((v) => !(v && from === switchFrom));
  };
  const switchPopRef = useRef<HTMLSpanElement | null>(null);
  // У правого края экрана список, выровненный влево, ушёл бы за край — сдвигаем ровно на вылет.
  useLayoutEffect(() => {
    const el = switchPopRef.current;
    if (!switchOpen || !el) return;
    el.style.left = '0px';
    const over = el.getBoundingClientRect().right - (window.innerWidth - 8);
    if (over > 0) el.style.left = `${-over}px`;
  }, [switchOpen, switchFrom]);
  // Щелчок мимо списка досок и Esc закрывают его: без этого он висел до перезагрузки.
  const closeSwitch = useCallback(() => setSwitchOpen(false), []);
  useDismiss(switchOpen, closeSwitch, '.board-switch-btn, .bp-name-btn');
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

    Память общая с разделом «Проекты» (см. lib/last-project) и живёт сутки:
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
    // доска этого проекта уже была на экране — показываем её, пока едет свежая
    const seen = boardsSeen.get(String(selected));
    if (seen && String(board?.project?.id ?? '') !== String(selected)) dispatch({ type: 'SET', board: seen });
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
    // Догнали пропущенное после разрыва (delta-sync, волна 9): перечитываем доску,
    // только если среди изменений есть задачи этого проекта.
    const onSync = (e: Event) => {
      if (syncTouches((e as CustomEvent<SyncDetail>).detail, { type: 'task', parentId: selected })) reloadBoard();
    };
    window.addEventListener(SYNC_EVENT, onSync);

    return () => {
      window.removeEventListener(SYNC_EVENT, onSync);
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




  /** #4798 §14: мягкий порог «в работе на человека» — только предупреждение. */
  const setWipLimit = async () => {
    if (!selected) return;
    const v = await promptText({
      title: 'Порог «в работе» на человека',
      description: 'Когда у человека в одной колонке задач больше порога, доска мягко предупредит. Это не запрет и не оценка занятости. Пусто — не следить.',
      placeholder: 'Например: 3', defaultValue: board?.project.wip_limit ? String(board.project.wip_limit) : '', confirmLabel: 'Сохранить', singleLine: true, minLength: 0,
    });
    if (v === null) return;
    const n = Number(v.trim());
    try { await flowApi.setWip(selected, v.trim() && Number.isFinite(n) && n > 0 ? Math.round(n) : null); reloadBoard(); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Не удалось сохранить порог'); }
  };

  const addColumn = async () => {
    if (!selected) return;
    const name = await promptText({ title: 'Новая колонка', placeholder: 'Например: На проверке', confirmLabel: 'Добавить', singleLine: true });
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

  /** ТЗ-30: тип этапа колонки — чья просрочка, пока задача в ней. */
  const setColumnStage = async (columnId: string, stage: string) => {
    if (!selected) return;
    try {
      await api.setColumnStage(selected, columnId, stage);
      reloadBoard();
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Не удалось поменять тип колонки'); }
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
    // #4799 §4.2: ничего молча — сколько задач и куда именно они переедут
    const col = board?.columns.find((c) => String(c.id) === String(columnId));
    const first = board?.columns.find((c) => String(c.id) !== String(columnId));
    const n = col?.tasks.length ?? 0;
    if (!(await confirmAction({
      title: `Удалить колонку «${name}»?`,
      description: n
        ? `В колонке задач: ${n}. Они не удалятся — переедут в «${first?.name ?? 'первую колонку'}» со всей перепиской и историей.`
        : 'Колонка пустая — задачи не затронуты.',
      danger: true,
    }))) return;
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

  /*
    «Черновик» (#1534): нажали кнопку — открываем окно создания с сохранённым текстом.
    Запрос может прийти раньше, чем загрузится доска нужного проекта, поэтому он
    лежит в task-draft и забирается, как только доска этого проекта готова.
    Колонку могли удалить — тогда первая колонка доски.
  */
  useEffect(() => {
    const tryOpen = () => {
      if (!board || String(board.project?.id ?? selected) !== String(selected)) return;
      const d = takeDraftOpen(selected);
      if (!d) return;
      const col = board.columns.find((c) => String(c.id) === String(d.columnId)) ?? board.columns[0];
      if (!col) return;
      setCreateIn({ columnId: col.id, columnName: col.name, draft: d });
    };
    tryOpen();
    window.addEventListener(TASK_DRAFT_OPEN, tryOpen);
    return () => window.removeEventListener(TASK_DRAFT_OPEN, tryOpen);
  }, [board, selected]);

  const moveTask = useCallback(
    async (taskId: string, columnId: string, visibleIndex: number, confirmGate = false, noAfterReason?: string, how: { raw?: boolean; undo?: boolean } = {}) => {
      const current = board?.columns.flatMap((c) => c.tasks).find((t) => t.id === taskId);
      // Перетаскивание сообщает место среди ВИДИМЫХ карточек. При включённом фильтре
      // это не настоящая позиция: между двумя своими задачами могут стоять чужие,
      // и без пересчёта задача уехала бы в начало колонки.
      const target = board?.columns.find((c) => c.id === columnId);
      const from = board?.columns.find((c) => c.id === current?.column_id);
      const opts = toFilter(query, String(user?.id ?? ''));
      // при порядке «по сроку» и т. п. место в колонке не выбирают — карточка встаёт в конец
      const position = !how.raw && target && ui.sort !== 'manual'
        ? target.tasks.length
        : !how.raw && user && target && filterActive(opts)
          ? realPosition(target.tasks, opts, visibleIndex, target.stage_type)
          : visibleIndex;
      /*
        Сдача на проверку (#4799 BOARD03): исполнитель переносит свою задачу в колонку
        проверки — коротко «что сделано, где посмотреть». Та же задача, тот же срок.
      */
      const me = String(user?.id ?? '');
      const isDoer = !!current && (String(current.assignee_id ?? '') === me || (current.co_assignees ?? []).some((p) => String(p.userId) === me));
      const toReview = !!target && REVIEW_STAGES.includes(target.stage_type ?? '')
        && !REVIEW_STAGES.includes(from?.stage_type ?? '') && !current?.closed_at;
      if (!how.undo && !confirmGate && current && target && isDoer && toReview && current.column_id !== columnId) {
        setHandoff({ task: current, columnId, columnName: target.name, position });
        return;
      }
      if (current) dispatch({ type: 'UPSERT_TASK', task: { ...current, column_id: columnId, position } });
      feedback('tap');
      try {
        const server = await api.moveTask(taskId, { columnId, position, confirmGate, noAfterReason });
        dispatch({ type: 'UPSERT_TASK', task: server });
        setGate(null);
        if (!how.undo && current && current.column_id !== columnId && from) {
          setUndo({ taskId, title: current.title, to: target?.name ?? '', fromColumn: from.id, fromPosition: current.position });
        }
        // мягкий порог «в работе на человека»: подсказка, а не запрет (#4798 §14)
        const limit = board?.project.wip_limit;
        if (limit && target && server.assignee_id && !PAUSED_STAGES.includes(target.stage_type ?? '') && target.stage_type !== 'done') {
          const n = target.tasks.filter((t) => String(t.assignee_id) === String(server.assignee_id) && String(t.id) !== String(taskId) && !t.closed_at).length + 1;
          if (n > limit) {
            showToast({ title: `У ${server.assignee_name ?? current?.assignee_name ?? 'исполнителя'} уже ${n} задач в «${target.name}»`, body: 'Проверьте, что сейчас важнее. Число задач — не оценка занятости: задачи бывают разной сложности.', kind: 'info' });
          }
        }
        // задача закрылась этим переносом — подтверждение, когда сервер согласился (ТЗ-23)
        const el = document.querySelector(`[data-task-id="${CSS.escape(String(taskId))}"]`);
        if (server?.closed_at && !current?.closed_at) feedback('task.completed', { el });
        else if (current && current.column_id !== columnId) feedback('task.moved', { el });
      } catch (e) {
        if (!(e instanceof ApiError && gateFromError(e.details))) feedback('error');
        // приёмка работы: не ошибка, а вопрос — показываем, чего не хватает, и даём решить
        const block = e instanceof ApiError ? gateFromError(e.details) : null;
        if (block) setGate({ block, taskId, columnId, position });
        else setError(e instanceof ApiError ? e.message : 'Не удалось перенести задачу');
        // карточка уже уехала оптимистично — возвращаем доску к тому, что на сервере
        if (selected) api.getBoard(selected).then((b) => dispatch({ type: 'SET', board: b }));
      }
    },
    [board, selected, query, user, ui.sort],
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
  const filterOpts = toFilter(query, uid);
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
  /*
    Числа у быстрых условий — каждое отдельно, в текущем режиме, ролях и фильтрах
    (#4799 §3.4); итог после всех «И» — отдельной строкой «Показано N».
  */
  const counts = useMemo(() => {
    const all = board?.columns.flatMap((c) => c.tasks) ?? [];
    const quick = {} as Record<QuickKey, number>;
    for (const q of QUICK) quick[q.key] = board ? countMatching(board.columns, { ...filterOpts, quick: [q.key] }) : 0;
    const mine = board ? countMatching(board.columns, { ...filterOpts, quick: [], assigneeId: null, creatorId: null, columnId: null, priority: null, labelId: null, search: '' }) : 0;
    return { shown: shownCount, mine, quick, active: all.filter((t) => !t.closed_at).length, done: all.filter((t) => !!t.closed_at).length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, query, uid, shownCount]);
  const hiddenLabels = useMemo(() => commonLabels(board?.columns.flatMap((c) => c.tasks) ?? []), [board]);
  /*
    Инфоцентр: «Что сейчас важно по проекту?» (#4798 §17) — по фактам доски, без
    догадок. Каждый пункт открывает свой срез; нет сигналов — так и сказано.
  */
  const signals = useMemo(() => {
    if (!board || !user) return [];
    const all = board.columns.flatMap((c) => c.tasks);
    const plural = (n: number, one: string, few: string, many: string) => {
      const m10 = n % 10; const m100 = n % 100;
      return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
    };
    const open = (patch: Partial<BoardQuery>) => () => setQuery({ ...query, scope: 'all', quick: [], ...patch } as BoardQuery);
    const out: { key: string; text: string; onOpen: () => void }[] = [];
    const decide = counts.quick.decide;
    if (decide) out.push({ key: 'decide', text: `${decide} ${plural(decide, 'задача ждёт', 'задачи ждут', 'задач ждут')} вашего решения`, onOpen: () => setReviewOpen(true) });
    const noInfo = all.filter((t) => t.is_blocked && t.blocker?.reason === 'no_info').length;
    if (noInfo) out.push({ key: 'noinfo', text: `Для ${noInfo} ${plural(noInfo, 'задачи', 'задач', 'задач')} не хватает информации`, onOpen: open({ quick: ['blocked'] }) });
    const blocked = all.filter((t) => t.is_blocked && t.blocker?.reason !== 'no_info').length;
    if (blocked) out.push({ key: 'blocked', text: `${blocked} ${plural(blocked, 'задача стоит', 'задачи стоят', 'задач стоят')} из-за препятствий`, onOpen: open({ quick: ['blocked'] }) });
    const answer = counts.quick.answer;
    if (answer) out.push({ key: 'answer', text: `В ${answer} ${plural(answer, 'задаче', 'задачах', 'задачах')} помощи ждут от вас`, onOpen: open({ quick: ['answer'] }) });
    const since = Date.now() - 36 * 3600_000;
    const fromCalls = all.filter((t) => !t.closed_at && t.audio_proof_sec && t.created_at && new Date(t.created_at).getTime() > since).length;
    if (fromCalls) out.push({ key: 'calls', text: `Из вчерашних созвонов — ${fromCalls} ${plural(fromCalls, 'новое поручение', 'новых поручения', 'новых поручений')}`, onOpen: open({}) });
    const overdue = counts.quick.overdue;
    if (overdue) out.push({ key: 'overdue', text: `${overdue} ${plural(overdue, 'задача просрочена', 'задачи просрочены', 'задач просрочено')}`, onOpen: open({ quick: ['overdue'] }) });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, counts, user?.id]);
  const boardLabels = useMemo(() => [...new Map((board?.columns.flatMap((c) => c.tasks) ?? [])
    .flatMap((t) => t.labels ?? []).map((l) => [String(l.id), { id: String(l.id), name: l.name }])).values()], [board]);

  /*
    Условие ссылается на то, чего больше нет (человека убрали, колонку удалили, тег
    стёрли) — снимаем его и говорим об этом, а не показываем молча пустую доску (§10).
  */
  useEffect(() => {
    if (!board || !users.length) return;
    const gone: string[] = [];
    const next = { ...query };
    if (query.assigneeId && !users.some((u) => String(u.id) === query.assigneeId)) { next.assigneeId = ''; gone.push('исполнитель'); }
    if (query.columnId && !board.columns.some((c) => String(c.id) === query.columnId)) { next.columnId = ''; gone.push('колонка'); }
    if (gone.length) { setQuery(next); setAccessNote(`Состав доски или доступа изменился — условие снято: ${gone.join(', ')}.`); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board?.project?.id, board?.columns.length, users.length]);

  // Ссылка на сохранённый вид: условия — из вида, задачи — по правам смотрящего.
  useEffect(() => {
    const id = pendingView.current;
    if (!id || !board || String(board.project.id) !== String(selected)) return;
    pendingView.current = null;
    flowApi.views(String(selected)).then((vs) => {
      const v = vs.find((x) => String(x.id) === id);
      if (!v) { setAccessNote('Этот вид вам недоступен — он личный или его удалили.'); return; }
      setQuery({ ...query, ...(v.query as Partial<BoardQuery>) } as BoardQuery);
      setActiveView(v.id);
    }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, selected]);

  // Положение доски: вернулись в проект — колонки прокручены туда же, где их оставили.
  // Ряд этапов (макет 01): какие колонки видны — подсвечены; нажатие — прокрутка к колонке
  const measureCols = useCallback(() => {
    const box = columnsRef.current;
    if (!box) return;
    const r = box.getBoundingClientRect();
    const vis = new Set<string>();
    box.querySelectorAll<HTMLElement>('[data-col-id]').forEach((el) => {
      const c = el.getBoundingClientRect();
      if (c.right > r.left + 24 && c.left < r.right - 24) vis.add(String(el.dataset.colId));
    });
    setVisibleCols((prev) => (prev.size === vis.size && [...vis].every((x) => prev.has(x)) ? prev : vis));
  }, []);
  useEffect(() => {
    const box = columnsRef.current;
    if (!box) return;
    measureCols();
    box.addEventListener('scroll', measureCols, { passive: true });
    window.addEventListener('resize', measureCols);
    return () => { box.removeEventListener('scroll', measureCols); window.removeEventListener('resize', measureCols); };
  }, [measureCols, board, view, hubOpen, ui.w]);
  const jumpTo = (id: string) => {
    const el = columnsRef.current?.querySelector<HTMLElement>(`[data-col-id="${CSS.escape(id)}"]`);
    el?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
  };
  const scrollKey = selected ? `qevo.board.scroll:${selected}` : '';
  const hasBoard = !!board;
  useEffect(() => {
    const el = columnsRef.current;
    if (!el || !scrollKey || view !== 'board') return;
    try { const x = Number(sessionStorage.getItem(scrollKey) ?? 0); if (x) el.scrollLeft = x; } catch { /* без хранилища */ }
    let t = 0;
    const onScroll = () => { window.clearTimeout(t); t = window.setTimeout(() => { try { sessionStorage.setItem(scrollKey, String(el.scrollLeft)); } catch { /* без хранилища */ } }, 200); };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { el.removeEventListener('scroll', onScroll); window.clearTimeout(t); };
  }, [scrollKey, view, hasBoard]);
  // пустой проект — «пустая воронка» (ТЗ-34): вместо «под фильтр ничего» — карточка заботы
  const boardEmpty = board?.columns.every((c) => !c.tasks.length);
  // Доске оставляем все колонки даже пустыми — иначе бросать задачу становится некуда;
  // в списке пустые заголовки только мешают.
  // Проект сменился, а выбранный постановщик в нём ничего не ставил — снимаем выбор,
  // иначе человек видит пустую доску и не понимает, почему.
  useEffect(() => {
    if (query.creatorId && board && !creators.some(([id]) => id === query.creatorId)) setQuery({ ...query, creatorId: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, board?.columns.length]);

  const filtered = board && user && filterActive(filterOpts)
    ? { ...board, columns: filterBoard(board.columns, filterOpts, view === 'board') }
    : board;
  const shownBoard = filtered && ui.sort !== 'manual'
    ? { ...filtered, columns: filtered.columns.map((c) => ({ ...c, tasks: sortTasks(c.tasks, ui.sort) })) }
    : filtered;


  /** Список проектов — один, место зависит от кнопки, которой его открыли (#4829). */
  const switchPop = (
    <span className="chat-pop board-switch-pop" data-pop ref={switchPopRef}>
      <input
        className="ui-input ui-input-sm"
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
            {!!p.unread && <span className="ui-badge ui-badge-info">{p.unread}</span>}
          </button>
        ))}
      <button
        className="chat-pop-row board-switch-all"
        onClick={() => { setSwitchOpen(false); forgetProject(); navigate({ section: 'projects' }); }}
      >
        <Icon name="list" size={13} /> Реестр всех проектов
      </button>
    </span>
  );

  return (
    <div className="board-layout">

      <main className="board-main board-v2">
        {error && <div className="tv2-callout tv2-callout-danger board-error" role="alert"><Icon name="alert" size={15} /> {error}</div>}
        {gate && (
          <HandoffGateDialog
            block={gate.block}
            onCancel={() => setGate(null)}
            onForce={(reason) => moveTask(gate.taskId, gate.columnId, gate.position, true, reason)}
          />
        )}
        {/* Пока проект не выбран или доска ещё едет — разные состояния, а не одна надпись:
            «выберите проект» на пустом аккаунте выглядит как тупик. */}
        {!board && (
          // при ошибке заглушку не показываем: она обещает данные, которых уже не будет
          (selected && !error) || projectsLoading ? (
            <SkeletonBoard />
          ) : projects.length === 0 ? (<>
            {canManageBoard && <CareEmpty k="tasks" />}
            <EmptyState
              icon="board"
              title="Здесь появится доска"
              hint={canManageBoard
                ? 'Создайте проект — и сможете вести задачи по колонкам. Уже работаете в YouGile? Подключите импорт в «Интеграциях».'
                : 'Как только вас добавят в проект, его доска откроется здесь.'}
              action={canManageBoard
                // поле создания живёт в меню слева — просим его принять курсор
                ? { label: 'Создать проект', onClick: () => {
                  // окно нового проекта живёт в «Проектах» (#1580): туда и ведём
                  try { sessionStorage.setItem(NEW_PROJECT_FOCUS, '1'); } catch { /* нет хранилища */ }
                  navigate({ section: 'projects' });
                  window.dispatchEvent(new Event(NEW_PROJECT_FOCUS));
                } }
                : undefined}
            />
          </>) : (
            <EmptyState icon="arrow-left" title="Выберите проект" hint="Список проектов — в меню слева, под разделом «Проекты и Задачи»." />
          )
        )}
        {board && (
          <>
            {/*
              Три уровня (#4799 §1, TOP01): где я (компания → раздел → проект), куда можно
              уйти из проекта («Все проекты», «Общие задачи») и команды ЭТОЙ доски ниже.
            */}
            {/* #4807 §2, строка 1 (30 px): «Компания /» · значок проекта · «Проект ▾» · ★ | «Все проекты ▾» · «Общие задачи ↗» */}
            <div className="bp-head">
              <span className="bp-crumbs">{organizations.find((o) => String(o.tenantId) === String(user?.tenantId))?.name ?? 'Компания'} /</span>
              <span className="bp-ico" aria-hidden="true">{board.project.name.trim().charAt(0).toUpperCase()}</span>
              <span className="board-switch">
                <h1 className="bp-name">
                  <button className="bp-name-btn" onClick={() => toggleSwitch('name')} aria-expanded={switchOpen && switchFrom === 'name'} title="Открыть список проектов">
                    {board.project.name} <Icon name="chevron-down" size={14} />
                  </button>
                </h1>
                {switchOpen && switchFrom === 'name' && switchPop}
              </span>
              {/* #4713: проект — в избранное, он появится в сайдбаре */}
              <FavoriteStar kind="project" id={String(board.project.id)} title={board.project.name} />
              <span className="bp-ctx">
                {/* «Все проекты ⌄» — переход к другому проекту и реестр; «Общие задачи» — задачи из нескольких проектов */}
                <span className="board-switch">
                  <Button variant="ghost" size="sm" className="board-switch-btn bp-all-btn" onClick={() => toggleSwitch('all')} aria-expanded={switchOpen && switchFrom === 'all'} title="Перейти к другому проекту или открыть реестр проектов">
                    Все проекты <Icon name="chevron-down" size={14} />
                  </Button>
                  {switchOpen && switchFrom === 'all' && switchPop}
                </span>
                <Button variant="ghost" size="sm" className="bp-quiet" onClick={() => navigate({ section: 'tasks' })} title="Задачи из всех доступных проектов, с названием проекта у каждой">
                  Общие задачи ↗
                </Button>
                {board.project.origin === 'bitrix' && (
                  <Button variant="ghost" size="sm" onClick={() => setShowFeed(true)} title="Живая лента импортированного проекта"><Icon name="list" size={15} /> Лента</Button>
                )}
              </span>
              {showFinance && <PnlPanel pnl={pnl} alert={alert} cow={cow} />}
            </div>
            {!isClient ? (
              <BoardBar
                query={query}
                onChange={setQuery}
                counts={counts}
                view={view}
                onView={switchView}
                onCreate={board.columns.length > 0 ? () => openCreate(board.columns[0].id) : undefined}
                createHint={board.columns[0] ? `Новая задача в «${board.project.name}», колонка «${board.columns[0].name}» (клавиша C)` : undefined}
                onVoice={onVoiceTask}
                onOpenReview={() => setReviewOpen(true)}
                users={users}
                columns={board.columns.map((c) => ({ id: c.id, name: c.name }))}
                labels={boardLabels}
                creators={creators}
                viewsSlot={(
                  <ViewsMenu
                    projectId={String(board.project.id)}
                    userId={uid}
                    isBoss={user?.role === 'owner' || user?.role === 'manager'}
                    query={query}
                    activeViewId={activeView}
                    onApply={(v) => { setQuery({ ...query, ...(v.query as Partial<BoardQuery>) } as BoardQuery); setActiveView(v.id); }}
                    inline
                  />
                )}
                stages={view === 'board' ? board.columns.map((c) => ({ id: String(c.id), name: c.name, visible: visibleCols.has(String(c.id)), count: c.tasks.length })) : undefined}
                onJump={jumpTo}
                onAllStages={() => { setUi({ col: { ...ui.col, [String(board.project.id)]: [] } }); if (query.columnId) setQuery({ ...query, columnId: '' }); columnsRef.current?.scrollTo({ left: 0, behavior: 'smooth' }); }}
                hubSlot={phone || view === 'list'
                  ? <HubColumn key={`hb${board.project.id}`} projectId={String(board.project.id)} ownerId={board.project.owner_user_id} variant="button" />
                  : (
                    <button className={`bb-hub-toggle${hubOpen ? ' is-on' : ''}`} onClick={() => setHubOpen(!hubOpen)} aria-expanded={hubOpen} title="Паспорт проекта, база знаний, решения и «Что сейчас важно»">
                      <Icon name="info" size={13} /> {hubOpen ? 'Скрыть Инфоцентр' : 'Инфоцентр проекта'}
                      {!hubOpen && signals.length > 0 && <span className="bb-n">{signals.length}</span>}
                      {!hubOpen && ' →'}
                    </button>
                  )}
                extraActions={(
                  <>
                    <DropdownMenu
                      trigger={(
                        <Button variant="ghost" size="sm" title="Настройки этой доски и вашего вида" aria-label="Настройки доски">
                          <Icon name="settings" size={15} /> <span className="bb-lbl">Настройки</span>
                        </Button>
                      )}
                    >
                      {canManageBoard && (
                        <MenuItem onSelect={() => setShowProjectSettings(true)} icon={<Icon name="settings" size={15} />}>Настройки проекта: место в списке досок</MenuItem>
                      )}
                      <MenuItem onSelect={() => setRulesOpen(true)} icon={<Icon name="zap" size={15} />}>Правила доски «Когда — тогда»</MenuItem>
                      {canManageBoard && (
                        <MenuItem
                          onSelect={() => { void setWipLimit(); }}
                          icon={<Icon name="users" size={15} />}
                        >
                          {board.project.wip_limit ? `Порог «в работе»: ${board.project.wip_limit} на человека` : 'Порог «в работе» на человека…'}
                        </MenuItem>
                      )}
                      <MenuSeparator />
                      {(['narrow', 'normal', 'wide'] as const).map((w) => (
                        <MenuItem key={w} onSelect={() => setUi({ w })} icon={<Icon name={ui.w === w ? 'check' : 'columns'} size={15} />}>
                          {w === 'narrow' ? 'Колонки узкие' : w === 'wide' ? 'Колонки широкие' : 'Колонки обычные'}
                        </MenuItem>
                      ))}
                      <MenuSeparator />
                      {SORTS.map((x) => (
                        <MenuItem key={x.key} onSelect={() => setUi({ sort: x.key })} icon={<Icon name={ui.sort === x.key ? 'check' : 'sort'} size={15} />}>
                          {x.label}
                        </MenuItem>
                      ))}
                      <MenuSeparator />
                      <MenuItem onSelect={() => setUi({ detail: false })} icon={<Icon name={ui.detail ? 'list' : 'check'} size={15} />}>
                        Плотность карточек: компактно
                      </MenuItem>
                      <MenuItem onSelect={() => setUi({ detail: true })} icon={<Icon name={ui.detail ? 'check' : 'list'} size={15} />}>
                        Плотность карточек: подробно
                      </MenuItem>
                      {!!(ui.col[String(board.project.id)] ?? []).length && (
                        <MenuItem onSelect={() => setUi({ col: { ...ui.col, [String(board.project.id)]: [] } })} icon={<Icon name="maximize" size={15} />}>
                          Развернуть все колонки
                        </MenuItem>
                      )}
                    </DropdownMenu>
                  </>
                )}
              />
            ) : (
              <div className="bb-row" style={{ marginBottom: 10 }}>
                <span className="kv2-seg" role="group" aria-label="Вид доски">
                  <button className="kv2-seg-btn" aria-pressed={view === 'board'} onClick={() => switchView('board')}><Icon name="board" size={15} /> Доска</button>
                  <button className="kv2-seg-btn" aria-pressed={view === 'list'} onClick={() => switchView('list')}><Icon name="list" size={15} /> Список</button>
                </span>
              </div>
            )}
            {accessNote && (
              <div className="tv2-callout tv2-callout-info" role="status">
                <Icon name="info" size={15} /> {accessNote}
                <Button variant="ghost" size="sm" onClick={() => setAccessNote('')}>Понятно</Button>
              </div>
            )}
            {!isClient && boardEmpty && <CareEmpty k="board" />}
            {filterActive(filterOpts) && shownCount === 0 && !boardEmpty ? (
              <EmptyState
                icon="filter"
                title="По этим условиям задач нет"
                hint="Условия перечислены над доской — снимите лишнее крестиком или сбросьте их разом. Режим и роли при сбросе останутся."
                action={{ label: 'Сбросить условия', onClick: () => setQuery({ ...query, quick: [], creatorId: '', assigneeId: '', columnId: '', priority: '', labelId: '', search: '' }) }}
              />
            ) : view === 'list' ? (
              <TaskListView
                board={shownBoard!}
                users={users}
                activeTimerTask={activeTimerTask}
                onOpenTask={(t) => setOpenTaskId(t.id)}
              />
            ) : (
              <div className={`board-columns w-${ui.w}${ui.detail ? '' : ' board-compact'}`} ref={columnsRef}>
                {/* Инфоцентр — перед колонками, но НЕ среди board.columns: «первая колонка»,
                    порядок и перенос карточек его не видят. Клиенту не показываем. */}
                {!isClient && hubOpen && !phone && (
                  <HubColumn key={board.project.id} projectId={String(board.project.id)} ownerId={board.project.owner_user_id} signals={signals} open onClose={() => setHubOpen(false)} />
                )}
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
                    onSetStage={setColumnStage}
                    onMoveColumn={moveColumn}
                    onDeleteColumn={deleteColumn}
                    onColumnDrop={reorderColumns}
                    columns={board.columns.map((c) => ({ id: c.id, name: c.name, count: c.tasks.length }))}
                    me={uid}
                    hiddenLabels={hiddenLabels}
                    wipLimit={board.project.wip_limit ?? null}
                    detail={ui.detail}
                    onQuickAdd={async (columnId, title) => {
                      try {
                        await api.createTask({ projectId: String(board.project.id), title, columnId: String(columnId), confirmedWithoutTags: true });
                        void reloadBoard();
                      } catch (e) {
                        setError(e instanceof ApiError ? e.message : 'Не удалось создать задачу');
                        throw e;
                      }
                    }}
                    collapsed={(ui.col[String(board.project.id)] ?? defaultCollapsed(board.columns)).includes(String(col.id))}
                    onToggleCollapse={(id) => {
                      const pid = String(board.project.id);
                      const cur = ui.col[pid] ?? defaultCollapsed(board.columns);
                      setUi({ col: { ...ui.col, [pid]: cur.includes(String(id)) ? cur.filter((x) => x !== String(id)) : [...cur, String(id)] } });
                    }}
                  />
                ))}
                {canManageBoard && (
                  <button className="add-column" onClick={addColumn} title="Добавить колонку">
                    <Icon name="plus" size={15} /> Колонка
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
          columns={board?.columns.map((c) => ({ id: c.id, name: c.name, stage_type: c.stage_type })) ?? []}
          canDelete={canManageBoard}
          timerActive={activeTimerTask === openTask.id}
          onToggleTimer={toggleTimer}
          onClose={() => setOpenTaskId(null)}
          onRefresh={reloadBoard}
        />
      )}
      {createIn && selected && (
        <TaskCreateModal
          /* другой черновик — другое окно: состояние формы не должно переехать из прошлого */
          key={createIn.draft?.id ?? 'new'}
          projectId={selected}
          columnId={createIn.columnId}
          columnName={createIn.columnName}
          projectName={board?.project.name}
          users={users}
          defaultManagerId={user?.id}
          onClose={() => setCreateIn(null)}
          onCreated={reloadBoard}
          draft={createIn.draft}
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
      {reviewOpen && (
        <ReviewQueue
          projectId={selected ?? undefined}
          projectName={board?.project.name}
          onClose={() => { setReviewOpen(false); reloadBoard(); }}
          onOpenTask={(t) => { setReviewOpen(false); if (String(t.project_id) === String(selected)) setOpenTaskId(String(t.id)); else navigate({ section: 'projects', projectId: String(t.project_id), taskId: String(t.id) }); }}
        />
      )}
      {rulesOpen && selected && <RulesDialog projectId={selected} onClose={() => setRulesOpen(false)} />}
      {handoff && (
        <HandoffDialog
          task={handoff.task}
          columnId={handoff.columnId}
          columnName={handoff.columnName}
          position={handoff.position}
          users={users}
          canPickReviewer={user?.role === 'owner' || user?.role === 'manager' || String(handoff.task.created_by ?? '') === uid}
          onClose={() => setHandoff(null)}
          onDone={(t) => { if (t) dispatch({ type: 'UPSERT_TASK', task: t }); setHandoff(null); reloadBoard(); }}
        />
      )}
      {undo && (
        <div className="bb-undo" role="status">
          <span>«{undo.title.length > 40 ? `${undo.title.slice(0, 40)}…` : undo.title}» → {undo.to}</span>
          <button onClick={() => { const u = undo; setUndo(null); void moveTask(u.taskId, u.fromColumn, u.fromPosition, false, undefined, { raw: true, undo: true }); }}>
            <Icon name="undo" size={13} /> Отменить
          </button>
        </div>
      )}
    </div>
  );
}
