import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { askOnConflict } from '../lib/device-prefs';
import { TaskClientField } from './TaskClientField';
import { navigate, parsePath } from '../lib/router';
import { useAuth } from '../state/auth';
import { Icon } from './Icon';
import { SaveTemplateDialog } from './SaveTemplateDialog';
import { GateBlock, HandoffGateDialog, gateFromError } from './HandoffGateDialog';
import { api, ApiError, QUEUED, request } from '../lib/api';
import { enqueueConflict, newChangeId, type QueuedChange } from '../lib/offline-queue';
import { flushOffline } from '../hooks/useOfflineQueue';
import { ConflictSheet } from './OfflineBar';
import type { Task, User } from '../types';
import { Lightbox } from './LightboxLazy';
import { TaskChat } from './TaskChat';
import { FavoriteStar } from './FavoriteStar';
import { RecurrencePane, repeatShort } from './task-single/RecurrencePane';
import { TaskMergeModal } from './TaskMergeModal';
import { AuthedMedia } from './AuthedMedia';
import { RichText } from './RichText';
import { RichEditor } from './RichEditor';
import { SuggestAssignee } from './SuggestAssignee';
import { DirectionsPicker } from './DirectionsPicker';
import { CLIENTS_ENABLED, MONETIZATION_ENABLED } from '../config';
import { TaskTagsField } from './TaskTagsField';
import { EMPTY_TAGS, TagsValue } from '../lib/tags';
import { followServer } from '../lib/local-edits';
import { overlayProps } from '../lib/overlay';
import { notifySeen, showToast, toastSaved } from '../lib/notifications';
import { AiFeedback } from './AiFeedback';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { confirmAction, promptText } from './ui/dialog';
import { DropdownMenu, MenuItem, MenuSeparator } from './ui/dropdown-menu';
import { Input } from './ui/input';
import { Select } from './ui/select';
import { GoogleFilesBlock } from './google/GoogleFilesBlock';
import { google } from '../lib/google';
import { useTitleHint } from '../lib/page-title';
import { feedback, feedback as fx } from '../lib/feedback';
import { INBOX_CHANGED, inboxApi } from '../lib/inbox-api';
// «Послушать контекст · 15 сек» (ТЗ-25) — отдельным куском, только у задач со встречи
const TaskAudioProof = lazy(() => import('./meetings/TaskAudioProof'));
// «Было/стало» (#4657) — своим куском и со своим CSS: отчёт смотрят после сдачи, не в каждой карточке
const BeforeAfterTab = lazy(() => import('./before-after/BeforeAfterTab'));
// #4798/#4799 → #5016: части потока работы расставлены по новой карточке
import { BlockerDialog, FlowNotices, FlowRecords, flowTimeRows, HandoffDialog, LinksRows, ShareDialog, TaskFocusDialog, useTaskFlow } from './task-flow/TaskFlowPanel';
import { TaskFamily } from './task-flow/TaskFamily';
import { REVIEW_STAGES } from '../lib/board-filter';
import { TaskFacts } from './task-single/TaskFacts';
import { TaskTabBar, type TabItem } from './task-single/TaskTabBar';
import { clock, FileTypeIcon, fileSize, HistoryRows, planTime, spentWords, useTaskTime } from './task-single/TaskPanes';
import './task-single/task-single.css';

interface Props {
  task: Task;
  users: User[];
  columns?: { id: string; name: string; stage_type?: string }[];
  /**
   * Удаление задачи. Отдельным правом, а не общим «управлением»: раньше одна галка
   * прятала и удаление, и ИИ-агента, и человек не понимал, чего именно ему не хватает.
   */
  canDelete?: boolean;
  timerActive: boolean;
  onToggleTimer: (taskId: string) => void;
  onClose: () => void;
  onRefresh: () => void;
}

/*
  #5016: вкладки карточки — одна полоса под описанием. «Обзора» нет (его содержимое — статика
  сверху), «Чата» нет (он справа; на узком экране — кнопкой в шапке), «Было/стало» — внутри «Агента».
*/
type PaneTab = 'checklist' | 'files' | 'links' | 'repeat' | 'time' | 'agent' | 'params' | 'history';
const PANES: PaneTab[] = ['checklist', 'files', 'links', 'repeat', 'time', 'agent', 'params', 'history'];
/** Последний открытый таб — для человека, на этом устройстве (ТЗ п. 6 d). */
const PANE_KEY = 'qevo.task.pane';
const plural = (n: number, a: string, b: string, c: string) => {
  const m10 = n % 10; const m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c;
};
const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Низкий' },
  { value: 'normal', label: 'Обычный' },
  { value: 'high', label: 'Высокий' },
  { value: 'urgent', label: 'Срочно' },
];

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

export function TaskDrawer({ task, users, columns = [], canDelete, timerActive, onToggleTimer, onClose, onRefresh }: Props) {
  // ссылка на отчёт «было/стало» (`/projects/:p/task/:t/check`) открывает карточку сразу на нём
  const [agentView, setAgentView] = useState<'agent' | 'ba'>(() => {
    const r = parsePath(window.location.pathname);
    return r.view === 'check' && String(r.taskId) === String(task.id) ? 'ba' : 'agent';
  });
  /*
    Какой таб открыть (ТЗ п. 6 d): последний открытый человеком — если в нём есть что смотреть
    (или это таб, который смотрят всегда); иначе первый слева, где что-то есть; всё пусто —
    «Чек-лист».
  */
  const [pane, setPane] = useState<PaneTab>(() => {
    if (agentView === 'ba') return 'agent';
    const filled: Partial<Record<PaneTab, boolean>> = {
      checklist: Number(task.checklistTotal ?? 0) > 0,
      files: Number(task.attachmentsCount ?? 0) > 0,
      links: Number(task.subtasksTotal ?? 0) > 0 || !!task.parent_task_id || !!task.waits_for?.length,
      repeat: !!task.recurrence_id,
    };
    let saved: PaneTab | null = null;
    try { saved = localStorage.getItem(PANE_KEY) as PaneTab | null; } catch { /* без хранилища */ }
    if (saved && PANES.includes(saved) && (!(saved in filled) || filled[saved])) return saved;
    return (['checklist', 'files', 'links', 'repeat'] as PaneTab[]).find((k) => filled[k]) ?? 'checklist';
  });
  const pickTab = (t: PaneTab) => {
    setPane(t);
    try { localStorage.setItem(PANE_KEY, t); } catch { /* без хранилища — просто не запомним */ }
  };
  const openAgent = (v: 'agent' | 'ba') => { setAgentView(v); setPane('agent'); };
  /** Чат во всю карточку: кнопка «Чат» в шапке (уже 1100 точек) и «Чат задачи» снизу на телефоне. */
  const [chatOpen, setChatOpen] = useState(false);
  /** «⋯ → Проверить было/стало»: вкладка откроется и сразу запустит проверку. */
  const [checkNow, setCheckNow] = useState(false);
  /*
    #4896: ссылка «Открыть „Было/стало“» в чате задачи — сразу на вкладку; бейдж «1» у вкладки,
    пока готовый отчёт не открыт (что открыто — помним в браузере по номеру отчёта).
  */
  const [baId, setBaId] = useState<string | null>(null);
  const baKey = `teamcrm.baSeen.${task.id}`;
  const [baSeen, setBaSeen] = useState<string | null>(() => { try { return localStorage.getItem(baKey); } catch { return null; } });
  useEffect(() => {
    request<{ id: string } | null>('GET', `/tasks/${task.id}/before-after/latest`).then((r) => setBaId(r?.id ?? null)).catch(() => setBaId(null));
  }, [task.id, pane, agentView]);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ taskId?: string; tab?: string }>).detail;
      if (!d?.tab || (d.taskId && String(d.taskId) !== String(task.id))) return;
      if (d.tab === 'check') openAgent('ba');
      else if (d.tab === 'chat') setChatOpen(true);
      else if (d.tab === 'agent') openAgent('agent');
      else if (PANES.includes(d.tab as PaneTab)) setPane(d.tab as PaneTab);
    };
    window.addEventListener('teamcrm:task-tab', on);
    return () => window.removeEventListener('teamcrm:task-tab', on);
  }, [task.id]);
  useEffect(() => {
    if (pane !== 'agent' || agentView !== 'ba' || !baId || baSeen === baId) return;
    setBaSeen(baId);
    try { localStorage.setItem(baKey, baId); } catch { /* без хранилища бейдж просто вернётся */ }
  }, [pane, agentView, baId, baSeen, baKey]);
  const baNew = !!baId && baSeen !== baId;
  // #4714: чат во всю карточку — довести до разговора, а не оставить его под блоком свойств
  const mainRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!chatOpen) return;
    const t = window.setTimeout(() => mainRef.current?.querySelector('.task-chat-box')?.scrollIntoView({ block: 'end' }), 60);
    return () => window.clearTimeout(t);
  }, [chatOpen]);
  /** Уже 900 точек «Есть препятствие», «Проверить ИИ» и «Отправить клиенту» уходят в «⋯» (ТЗ п. 8 b-2). */
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 900px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)');
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const flow = useTaskFlow(task);
  const time = useTaskTime(String(task.id), timerActive);
  const [blockerOpen, setBlockerOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);
  const [handoffTo, setHandoffTo] = useState<{ id: string; name: string } | null>(null);
  const [checks, setChecks] = useState({ done: Number(task.checklistDone ?? 0), total: Number(task.checklistTotal ?? 0) });
  useEffect(() => { setChecks({ done: Number(task.checklistDone ?? 0), total: Number(task.checklistTotal ?? 0) }); }, [task.id, task.checklistDone, task.checklistTotal]);
  /** Повтор словами для нижней строки «главного»: «Каждый пн, 10:00». */
  const [repeatLabel, setRepeatLabel] = useState<string | null>(null);
  useEffect(() => {
    if (!task.recurrence_id) { setRepeatLabel(null); return; }
    api.taskRecurrence(task.id).then((r) => setRepeatLabel(r?.active === false ? null : repeatShort(r))).catch(() => undefined);
  }, [task.id, task.recurrence_id, task.version]);
  const [clientName, setClientName] = useState<string | null>(null);
  const clientId = (task as { client_id?: string | null }).client_id ?? null;
  useEffect(() => {
    setClientName(null);
    if (CLIENTS_ENABLED && clientId) api.clientBrief(clientId).then((c) => setClientName(c.name)).catch(() => undefined);
  }, [clientId]);
  /** Описание выше 200 px сворачиваем с затуханием (ТЗ п. 5 b). */
  const [descTall, setDescTall] = useState(false);
  const [descOpen, setDescOpen] = useState(false);
  const descRO = useRef<ResizeObserver | null>(null);
  // картинки в описании догружаются позже — высоту следим наблюдателем, а не один раз
  const descBodyRef = useCallback((el: HTMLDivElement | null) => {
    descRO.current?.disconnect();
    descRO.current = null;
    if (!el) return;
    const check = () => setDescTall(el.scrollHeight > 210);
    check();
    descRO.current = new ResizeObserver(check);
    descRO.current.observe(el);
  }, []);
  const copyLink = () => {
    navigator.clipboard?.writeText(`${window.location.origin}/projects/${task.project_id}/task/${task.id}`).then(() => toastSaved('Ссылка скопирована')).catch(() => undefined);
  };
  // заголовок вкладки «#1137 Название» — ссылка из браузера скажет, о какой задаче речь (#1516)
  useTitleHint(task.id ? `task:${task.id}` : null, task.title ? `#${task.id} ${task.title}` : null);
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
  /*
    Срок в поле следует за задачей.

    Поле заполняется один раз при открытии карточки, и после «Сделал» оно продолжало
    показывать прежнюю дату: на экране не менялось ничего, и выходило, что кнопка не
    работает. Подхватываем новый срок — но только если человек сам это поле не правил,
    иначе обновление затрёт то, что он набрал.

    Прошлое значение берём В ПЕРЕМЕННУЮ до того, как переписать ref (#4652): функция
    в setDeadline выполняется позже, уже с новым ref, — поле считалось «правленым»,
    оставалось со старым сроком, кнопка «Сохранить» загоралась и возвращала его в задачу.
  */
  useEffect(() => {
    const prev = lastServerDeadline.current;
    setDeadline((cur) => followServer(cur, prev, initialDeadline));
    lastServerDeadline.current = initialDeadline;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDeadline]);
  const [warn, setWarn] = useState<any>(null);
  /** Какой срок пришёл с сервера в прошлый раз: по нему видно, правил ли поле человек. */
  const lastServerDeadline = useRef(initialDeadline);
  /** Что ответила кнопка «Сделал»: без строки на экране непонятно, случилось ли хоть что-то. */
  const [shiftNote, setShiftNote] = useState('');
  /** Просьбу о переносе решили здесь — панель прячем, не ждём перечитывания карточки (#4695). */
  const [shiftDecided, setShiftDecided] = useState(false);
  useEffect(() => { setShiftDecided(false); }, [task.id, task.deadline_shift_to]);
  // #4807 §6.5, п. 2: открыл задачу — её строки во «Входящих» прочитаны (не «Готово»)
  useEffect(() => {
    notifySeen({ taskId: String(task.id) }); // #4832: всплывашки об этой задаче — прочь
    void inboxApi.readTask(String(task.id)).then((r) => { if (r.changed) window.dispatchEvent(new Event(INBOX_CHANGED)); }).catch(() => undefined);
  }, [task.id]);
  /** Куда переехала задача — строкой под полем: перенос не должен проходить молча. */
  const [movedNote, setMovedNote] = useState('');
  /** Проекты для переноса: только те, которые человек видит. */
  const [projectList, setProjectList] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => { api.listProjects().then(setProjectList).catch(() => undefined); }, []);
  const [err, setErr] = useState('');
  /** Правка полей столкнулась с чужой (409 по версии): два варианта рядом, решает человек (волна 9). */
  const [conflict, setConflict] = useState<QueuedChange | null>(null);
  /*
    #5021: что МЫ уже сохранили в этой карточке — версия из ответа сервера и значения полей.
    Автосохранение идёт через секунду после каждой паузы: раньше второе уходило со старой
    версией (карточка ещё не перечитала задачу) и сервер отвечал «Задачу уже изменили» —
    конфликтом с собственной правкой секундной давности, с двумя одинаковыми текстами.
  */
  const savedRef = useRef<{ taskId: string; version: number | null; fields: Record<string, unknown> }>({ taskId: '', version: null, fields: {} });
  if (savedRef.current.taskId !== String(task.id)) savedRef.current = { taskId: String(task.id), version: null, fields: {} };
  const [desc, setDesc] = useState(task.description ?? '');
  /** Название правится прямо в карточке: раньше его можно было изменить только заново создав задачу. */
  const [title, setTitle] = useState(task.title ?? '');
  const [priority, setPriority] = useState(task.priority ?? 'normal');
  const { user } = useAuth();
  /** Решение принимает постановщик; владельцу тоже даём — он последняя инстанция. */
  const isManager = String(task.created_by ?? '') === String(user?.id ?? '') || user?.role === 'owner';
  /**
   * «Сделал — срок на среду»: кому и на каких задачах показывать.
   *
   * Только у ПОВТОРЯЮЩИХСЯ дел: кнопка задумана под них — закончил круг, следующий
   * срок сам встаёт на среду. У разовой задачи «следующей среды» не существует, и
   * кнопка там читалась как «продлить себе срок»; её срок правится полем «Срок».
   *
   * И только тем, кто вправе нажать: наблюдателю сервер вернул бы отказ.
   */
  const canShift = !!task.recurrence_id
    && (String(task.assignee_id ?? '') === String(user?.id ?? '')
      || String(task.created_by ?? '') === String(user?.id ?? '')
      || user?.role === 'owner');
  /** Предложенный срок человеческой строкой: по ней и принимают решение. */
  const shiftLabel = (at: string) => new Date(at).toLocaleString('ru-RU', {
    weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  });
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
  const [meeting, setMeeting] = useState<{ meeting_id: string; title: string | null; happened_at?: string | null; source_sec?: string | null } | null>(null);
  /** Из какого сообщения выросла задача: «а это вообще откуда?» — вопрос номер один. */
  const [fromMessage, setFromMessage] = useState<{
    message_id: string; chat_id: string; body: string; author_name: string | null;
    chat_title: string | null; project_name: string | null;
  } | null>(null);
  useEffect(() => {
    api.meetingOfTask(task.id).then(setMeeting).catch(() => setMeeting(null));
    api.taskSourceMessage(task.id).then(setFromMessage).catch(() => setFromMessage(null));
  }, [task.id]);

  /*
    Открыли карточку — изменения по ней больше не новые.

    Отметка ставится именно здесь, а не при прокрутке доски: увидеть, что написали
    в обсуждении или куда переехала задача, можно только открыв её. Гаснет отметка
    один раз, поэтому обновляем доску и счётчики панели сразу — иначе красная цифра
    висит на карточке до перезагрузки и человек открывает задачу второй раз.
  */
  useEffect(() => {
    // Отметку ставим ВСЕГДА, а не только когда карточка помечена красным.
    // Красная цифра на карточке живёт в данных доски и теряется от любого события,
    // пришедшего по сокету; счётчик у проекта считается на сервере и не теряется
    // никогда. Пока отметка зависела от цифры, задача с потерянной цифрой не
    // отмечалась прочитанной НИКОГДА — и счётчик проекта горел вечно.
    // Запрос дешёвый: одна строка на «задача × человек», обновляется на месте.
    api.markTaskRead(task.id)
      .then(() => { onRefresh(); window.dispatchEvent(new Event('teamcrm:tasks-changed')); })
      .catch(() => undefined); // отметка — не то, ради чего стоит показывать ошибку
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);
  const [managerId, setManagerId] = useState(task.created_by ?? '');
  const initialApproval = task.requires_approval !== false;
  const [approval, setApproval] = useState(initialApproval);
  const [saving, setSaving] = useState(false);
  /** Сколько файлов в задаче: цифра на вкладке отвечает «прикрепился ли», не открывая её. */
  const [fileCount, setFileCount] = useState(Number(task.attachmentsCount ?? 0));

  /**
   * Есть ли что сохранять.
   *
   * ОДНА кнопка на всю карточку и ОДИН признак изменений. Раньше сохранение было
   * рассыпано: название с описанием — своей кнопкой, план — другой, а приоритет,
   * постановщик и согласование применялись молча в момент выбора. Человек прикреплял
   * файл, смотрел на неактивную кнопку «Сохранено» и не понимал, применилось ли
   * хоть что-нибудь. Теперь правка любого поля зажигает кнопку, и пока она горит —
   * работа не сохранена.
   *
   * Перенос по колонкам сюда НЕ входит намеренно: это действие, а не правка, и
   * применяется оно сразу — как перетаскивание карточки на доске. Файлы, метки,
   * люди и чек-лист — тоже действия со своим мгновенным откликом.
   */
  const dirty = title !== (task.title ?? '')
    || desc !== (task.description ?? '')
    || String(assigneeId ?? '') !== String(task.assignee_id ?? '')
    || String(managerId ?? '') !== String(task.created_by ?? '')
    || String(priority ?? 'normal') !== String(task.priority ?? 'normal')
    || String(estimate ?? '') !== String(task.estimate_hours ?? '')
    || deadline !== initialDeadline
    || approval !== initialApproval;

  const userName = (id?: string | null) => users.find((u) => u.id === id)?.fullName ?? '—';

  /*
    Ctrl+S и Ctrl+Enter сохраняют карточку.

    Полоса сохранения внизу липкая, но карточка длинная: человек правит поле в
    середине и не видит, что кнопка зажглась. Привычное сочетание закрывает это
    без единого движения мышью — и работает из любого поля карточки.
  */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key !== 's' && e.key !== 'S' && e.key !== 'Enter') return;
      if (!dirty || saving) return;
      e.preventDefault();
      void saveAll(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, saving, title, desc, assigneeId, managerId, priority, estimate, deadline, approval]);

  /**
   * Сохранить карточку целиком.
   *
   * Порядок важен: СНАЧАЛА назначение — оно единственное умеет ответить отказом
   * («перегруз, подтвердите»). Если начать с названия и описания, а споткнуться на
   * назначении, половина правок уже записана, и повторное нажатие пишет их в историю
   * второй раз. Здесь же до подтверждения не записывается ничего.
   *
   * Согласование идёт своей ручкой намеренно: она пишет отдельное событие в историю
   * задачи и рассылает уведомления — сливать её с общей правкой полей нельзя.
   */
  /** true — сохранено (или ушло в очередь без сети); false — нет, причина на экране. */
  const saveAll = async (confirmOverload = false, quiet = false): Promise<boolean> => {
    if (!title.trim()) { setErr('Название не может быть пустым'); return false; }
    setErr('');
    setSaving(true);
    const estimateHours = estimate ? Number(estimate) : undefined;
    /*
      Пустое поле срока — это «убрать», а не «не трогать».

      Раньше сюда уходил undefined, сервер понимал его как «оставь как было», и
      просроченный срок было невозможно снять: заказчик так и сказал — «убираешь
      срок, а он не убирается после сохранения».
    */
    const deadlineAt = deadline ? new Date(deadline).toISOString() : null;
    const changedAssignee = String(assigneeId ?? '') !== String(task.assignee_id ?? '');
    const changedPlan = String(estimate ?? '') !== String(task.estimate_hours ?? '') || deadline !== initialDeadline;
    try {
      if (assigneeId && (changedAssignee || confirmOverload)) {
        // назначение идёт через прогноз — он и предупредит о перегрузе
        const res = await api.assignTask(task.id, { assigneeId, confirmOverload, estimateHours, deadlineAt });
        if (res.warning && !confirmOverload) { setWarn(res); setSaving(false); return false; }
        setWarn(null);
      } else {
        if (changedPlan) await api.saveTaskPlan(task.id, { estimateHours, deadlineAt });
        // исполнителя сняли — задача снова ничья, и это законное состояние
        if (!assigneeId && task.assignee_id) await api.updateTask(task.id, { assigneeId: null });
        setWarn(null);
      }

      const patch: Record<string, unknown> = {};
      if (title.trim() !== (task.title ?? '')) patch.title = title.trim();
      if (desc !== (task.description ?? '')) patch.description = desc;
      if (String(priority ?? 'normal') !== String(task.priority ?? 'normal')) patch.priority = priority;
      if (String(managerId ?? '') !== String(task.created_by ?? '')) patch.managerId = managerId || null;
      // Поля идут с версией задачи (If-Match): если её тем временем правил кто-то ещё,
      // сервер ответит 409, а не перезапишет чужое молча.
      if (Object.keys(patch).length) {
        const known = Math.max(Number(task.version ?? 0), Number(savedRef.current.version ?? 0)) || task.version;
        const remember = (res: unknown) => {
          const v = Number((res as { version?: unknown } | null)?.version);
          if (Number.isFinite(v) && v > 0) savedRef.current.version = v;
          Object.assign(savedRef.current.fields, patch);
        };
        try { remember(await api.updateTask(task.id, patch, known)); } catch (e) {
          // Сети нет — правка легла в очередь и уйдёт сама; для человека это «сохранено».
          if (e instanceof ApiError && e.code === QUEUED) {
            toastSaved('Сохранится, когда появится сеть');
            return true;
          }
          const d = (e instanceof ApiError && e.code === 'CONFLICT' ? e.details : null) as
            { reason?: string; task?: Record<string, unknown>; fields?: string[] } | null;
          if (d?.reason === 'version' && d.task) {
            /*
              #5021: настоящий ли это конфликт. Чужая правка — только если на сервере в этих
              полях не наш вариант и не то, что мы сами сохранили раньше (или что было при
              открытии). Иначе — тихо пишем поверх новой версии, без окна. И окно можно
              отключить совсем (Профиль → Уведомления): тогда всегда остаётся мой вариант.
            */
            const srv = d.task;
            const col: Record<string, string> = { managerId: 'created_by' };
            const same = (a: unknown, b: unknown) => String(a ?? '').replace(/\s+/g, ' ').trim() === String(b ?? '').replace(/\s+/g, ' ').trim();
            const real = Object.keys(patch).some((k) => {
              const now = srv[col[k] ?? k];
              const base = k in savedRef.current.fields ? savedRef.current.fields[k] : (task as unknown as Record<string, unknown>)[col[k] ?? k];
              return !same(now, patch[k]) && !same(now, base);
            });
            const srvVersion = Number(srv.version);
            if ((!real || !askOnConflict()) && Number.isFinite(srvVersion)) {
              remember(await api.updateTask(task.id, patch, srvVersion));
              onRefresh();
              return true;
            }
            setConflict(enqueueConflict({
              id: newChangeId(), method: 'PATCH', path: `/tasks/${task.id}`, body: patch,
              ifMatch: task.version ?? null, label: `Правка задачи #${task.id}`,
              preview: String(patch.title ?? patch.description ?? ''),
            }, d.task, d.fields ?? []));
            return false;
          }
          throw e;
        }
      }

      if (approval !== initialApproval) await api.setTaskApproval(task.id, approval);

      onRefresh();
      // автосохранение — молча, как в Битриксе: всплывашка на каждую паузу в наборе раздражает
      if (!quiet) { toastSaved('Задача сохранена'); feedback('task.saved'); }
      return true;
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Ошибка'); return false; }
    finally { setSaving(false); }
  };

  /*
    #4852: автосохранение вместо кнопки «Сохранить» — как в Битриксе.

    Любая правка поля уходит на сервер сама через секунду тишины: печатать можно не
    отвлекаясь, а запросов — по одному на паузу, а не на букву. Не получилось (перегруз
    исполнителя ждёт подтверждения, конфликт версий, ошибка) или ушло в очередь без
    сети — тот же набор правок второй раз не шлём, пока человек его не поменяет.
    Пустое название не сохраняем — подскажем, когда закроют карточку.
  */
  const draftSig = JSON.stringify([title, desc, assigneeId, managerId, priority, estimate, deadline, approval]);
  const sentSig = useRef<string | null>(null);
  useEffect(() => {
    if (!dirty || saving || !title.trim() || sentSig.current === draftSig) return;
    const timer = window.setTimeout(() => {
      sentSig.current = draftSig;
      void saveAll(false, true);
    }, 1000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftSig, dirty, saving]);

  /*
    Закрыть карточку (#1554). Несохранённое (закрыли раньше, чем прошла секунда)
    дописываем сразу; не сохранилось — карточка остаётся открытой с причиной.
  */
  const closeSafe = async () => {
    if (!dirty) { onClose(); return; }
    if (!title.trim()) {
      const drop = await confirmAction({
        title: 'Название пустое',
        description: 'Без названия задачу не сохранить. Закрыть и не сохранять последние правки?',
        confirmLabel: 'Закрыть', cancelLabel: 'Вернуться',
      });
      if (drop) onClose();
      return;
    }
    if (await saveAll(false, true)) onClose();
  };
  /**
   * Решение постановщика по сданной работе.
   *
   * Обе кнопки живут в карточке, а не на доске: чтобы принять работу, надо сначала
   * её посмотреть, а «принять не глядя» — способ обесценить всю затею.
   */
  /**
   * «Сделал» — отчитаться и подвинуть срок на следующую среду 17:00.
   *
   * Просьба заказчика для дел, которые повторяются каждую неделю: закончил круг —
   * одно нажатие вместо календаря. Срок при этом не уезжает сам: пока постановщик не
   * подтвердит, в задаче стоит прежняя дата (иначе это кнопка «продлить себе срок»).
   */
  const askShift = async () => {
    /*
      Спрашиваем ДО, отвечаем ПОСЛЕ.

      «Непонятно, как кнопка работает» — потому что она молча делала своё дело.
      Теперь до нажатия сказано, что произойдёт, а после видно, что именно вышло:
      перенесли сразу или отправили постановщику на подтверждение.
    */
    const ok = await confirmAction({
      title: 'Отчитаться «Сделал» и перенести срок на следующую среду, 17:00?',
      description: 'Постановщик получит уведомление и подтвердит перенос. До его ответа срок останется прежним.',
      confirmLabel: 'Сделал',
    });
    if (!ok) return;
    setErr('');
    try {
      const res = await api.askDeadlineShift(task.id);
      setShiftNote(res.deadline_shift_to
        ? `Отправлено постановщику: перенести срок на ${shiftLabel(res.deadline_shift_to)}. До подтверждения срок прежний.`
        : `Срок перенесён на ${res.deadline_at ? shiftLabel(res.deadline_at) : 'следующую среду, 17:00'}.`);
      onRefresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  /** Ответ постановщика на просьбу о переносе. */
  const decideShift = async (approve: boolean) => {
    setErr('');
    try {
      const res = await api.decideDeadlineShift(task.id, approve);
      // #4695: панель решения прячем сразу — не дожидаясь, пока карточка перечитается
      setShiftDecided(true);
      setShiftNote(approve
        ? `Срок перенесён${res?.deadline_at ? ` на ${shiftLabel(res.deadline_at)}` : ''}.`
        : 'Срок оставлен прежним.');
      onRefresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  /**
   * Перенести задачу в другой проект.
   *
   * Колонку в целевом проекте подбирает сервер — по названию текущей: задача «в
   * работе» не должна возвращаться в «Новые» просто потому, что переехала.
   */
  const moveToProject = async (projectId: string) => {
    if (!projectId || String(projectId) === String(task.project_id)) return;
    const to = projectList.find((p) => String(p.id) === String(projectId));
    if (!(await confirmAction({
      title: `Перенести задачу в проект «${to?.name ?? projectId}»?`,
      description: 'Переписка, вложения, чек-лист и учтённое время переедут вместе с ней.',
      confirmLabel: 'Перенести',
    }))) return;
    setErr('');
    try {
      await api.moveTaskToProject(task.id, projectId);
      setMovedNote(`Задача перенесена в «${to?.name ?? ''}»`);
      onRefresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const decide = async (accept: boolean) => {
    setErr('');
    try {
      if (accept) { await api.approveTask(task.id); feedback('task.approved'); }
      else {
        const reason = await promptText({
          title: 'Вернуть в работу',
          description: 'Что доработать? Причина уйдёт исполнителю и останется в истории задачи.',
          placeholder: 'Например: не хватает макета мобильной версии',
          confirmLabel: 'Вернуть',
        });
        if (!reason?.trim()) return; // молча вернуть работу нельзя — это ссора на ровном месте
        await api.returnTask(task.id, reason.trim());
      }
      onRefresh();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Ошибка'); }
  };


  /*
    «Копировать задачу» (#4736): новая задача с тем же содержимым — название с пометкой
    «(копия)», описание, исполнитель, соисполнители, наблюдатели, приоритет, оценка,
    направления, теги и чек-лист (пункты не отмечены). Срок — только если ещё не прошёл.
    Постановщик — тот, кто копирует; встаёт в первую колонку. Открываем копию сразу:
    поправить пару полей и запустить, не прописывая заново.
  */
  const [copying, setCopying] = useState(false);
  const copyTask = async () => {
    setCopying(true); setErr('');
    try {
      const checklist = (await api.listChecklist(String(task.id)).catch(() => [])).map((i: { text: string }) => i.text).filter(Boolean);
      const labelIds = (task.labels ?? []).map((l) => String(l.id));
      const future = task.deadline_at && new Date(task.deadline_at).getTime() > Date.now() ? task.deadline_at : undefined;
      const copy = await api.createTask({
        projectId: String(task.project_id),
        title: `${task.title} (копия)`.slice(0, 255),
        description: task.description ?? undefined,
        assigneeId: task.assignee_id ?? undefined,
        priority: task.priority,
        deadlineAt: future,
        estimateHours: task.estimate_hours ? Number(task.estimate_hours) : undefined,
        requiresApproval: task.requires_approval,
        directions: task.directions?.length ? task.directions : undefined,
        checklist: checklist.length ? checklist : undefined,
        labelIds,
        // теги взяты у исходной задачи, которую уже подтвердили, — второй раз не спрашиваем
        tagsConfirmed: labelIds.length > 0, confirmedWithoutTags: labelIds.length === 0,
        coAssigneeIds: participants.filter((x) => x.role === 'co_assignee').map((x) => String(x.user_id)),
        watcherIds: participants.filter((x) => x.role === 'watcher').map((x) => String(x.user_id)),
        // копируют осознанно — предупреждение о нагрузке исполнителя не останавливает
        confirmWorkload: true,
      });
      toastSaved('Копия создана', 'Поправьте, что нужно, — задача уже на доске');
      navigate({ section: 'projects', projectId: String(copy.project_id), taskId: String(copy.id) });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось скопировать задачу');
    } finally {
      setCopying(false);
    }
  };
  // сменить статус = переместить в колонку доски (наверх колонки)
  const [moving, setMoving] = useState(false);
  /** Открыто окно объединения: поиск дубля и предпросмотр. */
  /*
    «Сохранить как шаблон» (просьба заказчика).

    Закрепляет СПОСОБ ставить работу, которая повторяется: название, описание,
    чек-лист, теги и привычный исполнитель. Имя шаблона спрашиваем отдельно — см.
    SaveTemplateDialog.
  */
  const [saveTpl, setSaveTpl] = useState(false);
  const [tplNote, setTplNote] = useState('');

  const [merging, setMerging] = useState(false);
  /** Идёт проверка ИИ: она читает вложения и занимает секунды, а не мгновение. */
  const [reviewing, setReviewing] = useState(false);

  /**
   * Проверка задачи ИИ.
   *
   * Отчёт уходит в переписку задачи — там его увидят все участники, а не только
   * нажавший. Наверху показываем лишь короткий итог: подробности читаются в чате.
   */
  const runReview = async () => {
    setErr('');
    setReviewing(true);
    try {
      const r = await api.reviewTask(task.id);
      onRefresh();
      window.dispatchEvent(new CustomEvent('teamcrm:task-chat-reload', { detail: { taskId: task.id } }));
      const title = r.verdict === 'done' ? 'ИИ: похоже, сделано'
        : r.verdict === 'partial' ? 'ИИ: сделано не всё'
          : r.verdict === 'not_done' ? 'ИИ: подтверждений нет'
            : 'ИИ: проверить не смог';
      showToast({ title, body: r.summary || 'Отчёт — в обсуждении задачи', section: 'focus' });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось проверить задачу');
    } finally { setReviewing(false); }
  };

  /** Описание правится по кнопке: по умолчанию его читают, а не редактируют. */
  const [editingDesc, setEditingDesc] = useState(false);
  /** Фраза, из которой агент завёл задачу, — целиком (#4670): подсказки по наведению на телефоне нет. */
  const [sourceOpen, setSourceOpen] = useState(false);
  const [descBusy, setDescBusy] = useState(false);

  /**
   * Картинка в описание — из буфера (Ctrl+V) или кнопкой на панели редактора.
   *
   * Файл уезжает во вложения задачи, а в описание встаёт ссылка на него — картинка
   * видна и в тексте, и во вкладке «Файлы». Раньше вставить снимок в постановку
   * было нельзя вовсе: приходилось сохранять его на диск и прикладывать файлом.
   */
  const uploadDescImage = async (file: File): Promise<{ fileId: string; name: string }> => {
    setDescBusy(true);
    try {
      // Имя со временем: у снимка из буфера его нет вовсе, и в списке файлов
      // получалась стопка «image.png».
      const stamp = new Date().toLocaleString('ru-RU').replace(/[:.]/g, '-');
      const anonymous = !file.name || /^image\.\w+$/i.test(file.name);
      const named = anonymous ? new File([file], `Снимок ${stamp}.png`, { type: file.type || 'image/png' }) : file;
      const up = await api.uploadAttachment(task.id, named);
      setFileCount((n) => n + 1);
      onRefresh();
      return { fileId: String(up.fileId), name: named.name };
    } catch (er) {
      setErr(er instanceof ApiError ? er.message : 'Не удалось приложить картинку');
      throw er;
    } finally { setDescBusy(false); }
  };
  /** Снимок из описания — во весь экран: разглядеть макет в узкой карточке нельзя. */
  const [descPreview, setDescPreview] = useState<{ url: string; name: string; mime: string } | null>(null);
  // приёмка работы: сдаём не полностью — сначала показываем, чего не хватает
  const [gate, setGate] = useState<{ block: GateBlock; columnId: string } | null>(null);
  const moveToColumn = async (columnId: string, confirmGate = false, noAfterReason?: string) => {
    if (columnId === task.column_id || moving) return;
    setErr(''); setMoving(true);
    feedback('tap');
    try {
      const server = await api.moveTask(task.id, { columnId, position: 0, confirmGate, noAfterReason });
      feedback(server?.closed_at && !task.closed_at ? 'task.completed' : 'task.moved');
      setGate(null); onRefresh();
    }
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
  /** Отмена задачи, которую агент завёл сам по переписке: в корзину, промах засчитан. */
  const undoAi = async () => {
    if (!(await confirmAction({
      title: `Отменить задачу «${task.title}»?`,
      description: 'Она уйдёт в корзину, а в чате появится отметка об отмене.',
      confirmLabel: 'Отменить задачу', danger: true,
    }))) return;
    setErr(''); setMoving(true);
    try {
      await api.undoAiTask(task.id);
      onRefresh();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось отменить задачу');
    } finally {
      setMoving(false);
    }
  };

  const removeTask = async (confirmTimeLoss = false) => {
    if (!confirmTimeLoss && !(await confirmAction({
      title: `Удалить задачу «${task.title}»?`,
      // задача уходит в корзину целиком — с комментариями, чек-листом и файлами
      description: 'Задача попадёт в корзину вместе с комментариями, чек-листом и вложениями. Вернуть её можно в «Общие задачи» → «Корзина».',
      danger: true,
    }))) return;
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
        if (await confirmAction({
          title: 'Удалить задачу?',
          description: e instanceof ApiError ? e.message : undefined,
          danger: true,
        })) {
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
  const isDone = !!task.closed_at;
  const targets = orderColumns(columns, isDone ? 'reopen' : 'finish').filter((c) => c.id !== task.column_id);
  const doneTarget = isDone ? null : targets.find((c) => DONE_RE.test(c.name.trim())) ?? null;
  /** Где задача стоит сейчас — подпись в шапке чата: «о чём разговор и на каком этапе». */
  const columnName = columns.find((c) => String(c.id) === String(task.column_id))?.name ?? null;

  /*
    Файл, перетащенный НА КАРТОЧКУ (жалоба: «в задаче не удаётся приложить файл
    переносом из папки»).

    Раньше приём перетаскивания был только внутри вкладки «Файлы», в небольшой рамке.
    Человек тянет файл на карточку целиком — и попадает мимо; браузер при этом
    открывает файл в соседней вкладке, то есть выглядит это как «ничего не работает».
    Теперь карточка принимает файл в любом месте и говорит об этом, пока его тянут.
  */
  const [dragOver, setDragOver] = useState(false);
  const dropOnCard = async (list: FileList | null) => {
    const picked = Array.from(list ?? []);
    if (!picked.length) return;
    setErr('');
    let ok = 0;
    // #4887: в уже созданной задаче файл — ещё и сообщением в чат задачи (как в Битриксе),
    // во вкладку «Файлы» он попадает тоже; десять — предел одного сообщения
    for (let i = 0; i < picked.length; i += 10) {
      const part = picked.slice(i, i + 10);
      try { await api.addCommentFile(task.id, part, ''); setFileCount((n) => n + part.length); ok += part.length; }
      catch (e) { setErr(e instanceof ApiError ? `${part.map((f) => f.name).join(', ')}: ${e.message}` : `Не удалось приложить ${part.map((f) => f.name).join(', ')}`); }
    }
    onRefresh();
    // #4664: «Файл приложен» только о том, что действительно долетело
    if (ok) toastSaved('Файл приложен', ok > 1 ? `${ok} шт. — в чате задачи и во вкладке «Файлы»` : picked.length === 1 ? picked[0].name : '1 шт. — в чате задачи и во вкладке «Файлы»');
  };

  // ── #5016: новая раскладка — статика сверху, одна полоса табов снизу ──
  const projectName = projectList.find((p) => String(p.id) === String(task.project_id))?.name ?? '';
  const reviewCol = columns.find((c) => REVIEW_STAGES.includes(c.stage_type ?? ''));
  const curStage = columns.find((c) => String(c.id) === String(task.column_id))?.stage_type ?? '';
  const inReview = task.approval_state === 'pending' || REVIEW_STAGES.includes(curStage);
  const canShare = flow.isDoer || String(task.created_by ?? '') === flow.me || flow.isBoss;
  const linksCount = Number(task.subtasksTotal ?? 0) + (task.parent_task_id ? 1 : 0) + flow.links.length;
  const subDone = Number(task.subtasksDone ?? 0);
  const tabItems: TabItem<PaneTab>[] = [
    { key: 'checklist', label: 'Чек-лист', icon: 'check-circle', state: checks.total ? 'has' : 'empty', count: `${checks.done}/${checks.total}` },
    { key: 'files', label: 'Файлы', icon: 'paperclip', state: fileCount ? 'has' : 'empty', count: fileCount },
    { key: 'links', label: 'Связи', icon: 'link', state: linksCount ? 'has' : 'empty', count: Number(task.subtasksTotal ?? 0) ? `${subDone}/${task.subtasksTotal}` : linksCount },
    { key: 'repeat', label: 'Повтор', icon: 'refresh', state: task.recurrence_id ? 'has' : 'empty' },
    { key: 'time', label: 'Время', icon: 'clock', state: estimate || time.totalSec ? 'has' : 'normal', count: time.totalSec ? spentWords(time.totalSec).replace(' 00 мин', '') : undefined },
    { key: 'agent', label: 'Агент', icon: 'robot', state: task.agent_assigned || baId ? 'has' : 'normal', count: baNew ? 1 : undefined },
    { key: 'params', label: 'Параметры', icon: 'settings', state: 'normal' },
    { key: 'history', label: 'История', icon: 'book', state: 'normal' },
  ];
  const finishExtras = (
    <>
      {!inReview && !task.closed_at && reviewCol && flow.isDoer && (
        <MenuItem onSelect={() => setHandoffTo({ id: String(reviewCol.id), name: reviewCol.name })} icon={<Icon name="send" size={14} />}>
          Передать на проверку
        </MenuItem>
      )}
      {canShift && (
        <MenuItem onSelect={() => void askShift()} disabled={!!task.deadline_shift_to} icon={<Icon name="check-circle" size={14} />}>
          {task.deadline_shift_to ? 'Перенос уже отправлен постановщику' : 'Сделал — срок на среду'}
        </MenuItem>
      )}
    </>
  );
  const hasFinishExtras = (!inReview && !task.closed_at && !!reviewCol && flow.isDoer) || canShift;
  const moreItems = (withNarrow: boolean) => (
    <>
      {withNarrow && !task.closed_at && (
        <MenuItem onSelect={() => setBlockerOpen(true)} icon={<Icon name="ban" size={15} />}>{task.is_blocked ? 'Изменить препятствие' : 'Есть препятствие'}</MenuItem>
      )}
      {withNarrow && <MenuItem onSelect={() => void runReview()} disabled={reviewing} icon={<Icon name="sparkles" size={15} />}>{reviewing ? 'Проверяю…' : 'Проверить ИИ'}</MenuItem>}
      {withNarrow && canShare && <MenuItem onSelect={() => setShareOpen(true)} icon={<Icon name="link" size={15} />}>Отправить клиенту</MenuItem>}
      {withNarrow && <MenuSeparator />}
      {!task.closed_at && flow.isDoer && !flow.inFocus && (
        <MenuItem onSelect={() => setFocusOpen(true)} icon={<Icon name="target" size={15} />}>Начать фокус</MenuItem>
      )}
      {!task.merged_into_id && (
        <MenuItem onSelect={() => setMerging(true)} icon={<Icon name="refresh" size={15} />} disabled={moving}>Объединить с дублем</MenuItem>
      )}
      <MenuItem onSelect={() => { setCheckNow(true); openAgent('ba'); }} icon={<Icon name="eye" size={15} />} disabled={moving}>Проверить было/стало</MenuItem>
      <MenuItem onSelect={() => void copyTask()} icon={<Icon name="copy" size={15} />} disabled={moving || copying}>{copying ? 'Копирую…' : 'Копировать задачу'}</MenuItem>
      {/* Шаблон — про СПОСОБ работы, поэтому среди действий над задачей целиком. */}
      <MenuItem onSelect={() => setSaveTpl(true)} icon={<Icon name="copy" size={15} />} disabled={moving}>Сохранить как шаблон</MenuItem>
      <MenuItem onSelect={copyLink} icon={<Icon name="link" size={15} />}>Скопировать ссылку</MenuItem>
      {canDelete && (
        <>
          <MenuSeparator />
          <MenuItem destructive onSelect={() => void removeTask()} icon={<Icon name="trash" size={15} />} disabled={moving}>Удалить задачу</MenuItem>
        </>
      )}
    </>
  );

  return (
    <div className="drawer-overlay" {...overlayProps(() => void closeSafe())}>
      {/*
        Карточка и чат стоят рядом, как в Битриксе: слева задача, справа разговор по ней.
        #5016: уже 1100 точек чат справа прячется — открывается кнопкой «Чат» в шапке.
      */}
      <aside
        className={`drawer drawer-task task-v2 ts3${chatOpen ? ' drawer-task-chat' : ''}${dragOver ? ' drawer-drag' : ''}`}
        onClick={(e) => e.stopPropagation()}
        onDragOver={(e) => {
          // Реагируем только на файлы: перетаскивание текста или карточки внутри окна
          // к вложениям отношения не имеет.
          if (!Array.from(e.dataTransfer.types ?? []).includes('Files')) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
        onDrop={(e) => {
          if (!Array.from(e.dataTransfer.types ?? []).includes('Files')) return;
          e.preventDefault();
          setDragOver(false);
          void dropOnCard(e.dataTransfer.files);
        }}
      >
        {/* Пока файл над карточкой — говорим, что с ним будет. */}
        {dragOver && (
          <div className="drawer-drop-hint" aria-hidden="true">
            <Icon name="paperclip" size={18} /> Отпустите — приложу к задаче
          </div>
        )}
        <div className="task-main" ref={mainRef}>
        {gate && (
          <HandoffGateDialog
            block={gate.block}
            busy={moving}
            taskId={String(task.id)}
            onCancel={() => setGate(null)}
            onForce={(reason) => moveToColumn(gate.columnId, true, reason)}
          />
        )}

        {/* a-1. Шапка: номер, проект, статус-метка, звёздочка; справа ссылка, меню, закрыть */}
        <div className="tv2-crumbs ts-top">
          {/* Номер нужен человеку, а не системе: по нему задачу называют боту в отчёте
              и в переписке. Клик копирует — переписывать цифры с экрана никто не должен. */}
          <button
            className="tv2-num"
            onClick={() => {
              navigator.clipboard?.writeText(`#${task.id}`).then(() => toastSaved('Номер скопирован', `#${task.id}`)).catch(() => undefined);
            }}
            title="Номер задачи — скопировать. По нему задачу называют боту в отчёте"
          >
            #{task.id}
          </button>
          {projectName && <><span className="ts-crumb">{projectName}</span><span className="tv2-dot ts-crumb" aria-hidden>·</span></>}
          {columnName && <span className="ts-stage">{columnName}</span>}
          {isDone && <Badge tone="ok"><Icon name="check" size={11} /> завершена</Badge>}
          {task.agent_assigned && <Badge tone="info" title="Исполнитель — ИИ-агент"><Icon name="robot" size={11} /> ИИ-агент</Badge>}
          {task.is_blocked && <Badge tone="warn" title={task.blocker?.need ?? 'Отмечено «Есть препятствие»'}><Icon name="ban" size={11} /> Остановлено</Badge>}
          {/* #4713: задачу — в избранное, она появится в сайдбаре */}
          <FavoriteStar kind="task" id={String(task.id)} title={task.title} projectId={String(task.project_id)} />
          <span className="ts-sp" />
          {!chatOpen && (
            <Button variant="ghost" size="sm" className="ts-chat-btn" onClick={() => setChatOpen(true)} title="Открыть чат задачи">
              <Icon name="chat" size={15} /> Чат{Number(task.unread ?? 0) > 0 && <span className="ts-tab-n">{task.unread}</span>}
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" onClick={copyLink} title="Скопировать ссылку на задачу" aria-label="Скопировать ссылку на задачу"><Icon name="link" size={16} /></Button>
          <DropdownMenu trigger={<Button variant="ghost" size="icon-sm" aria-label="Действия с задачей" title="Действия с задачей"><Icon name="more" size={16} /></Button>}>
            {moreItems(false)}
          </DropdownMenu>
          {/* Закрытие — крупной кнопкой: уходить из карточки надо уверенным движением. */}
          <Button variant="ghost" size="icon" className="tv2-close" onClick={() => void closeSafe()} title="Закрыть карточку" aria-label="Закрыть карточку">
            <Icon name="close" size={18} />
          </Button>
        </div>

        {/* a-2. Заголовок правится прямо здесь, как в Битриксе; поле растёт под текст. */}
        <h2 className="tv2-title">
          <textarea
            className="drawer-title-input"
            value={title}
            rows={1}
            placeholder="Название задачи"
            aria-label="Название задачи"
            onChange={(e) => setTitle(e.target.value)}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = 'auto';
              el.style.height = `${el.scrollHeight}px`;
            }}
            ref={(el) => {
              if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; }
            }}
          />
        </h2>

        {/* Задача объединена — первой строкой: иначе работа продолжится в закрытой копии. */}
        {task.merged_into_id && (
          <div className="tv2-callout tv2-callout-info">
            <Icon name="refresh" size={15} />
            <span>Объединена с задачей #{task.merged_into_id} — работа продолжается там.</span>
            <Button size="sm" variant="outline" onClick={() => navigate({ section: 'projects', projectId: String(task.project_id), taskId: String(task.merged_into_id) })}>
              Открыть
            </Button>
          </div>
        )}

        {chatOpen ? (
          <TaskChat
            taskId={task.id}
            assigneeId={task.assignee_id}
            creatorId={task.created_by}
            participants={participants}
            onRefresh={onRefresh}
            wide
            title={task.title}
            status={columnName}
            projectId={task.project_id}
            onCollapse={() => setChatOpen(false)}
          />
        ) : (
          <>
            {/* a-3. Карточка «главное» */}
            <TaskFacts
              task={task}
              users={users}
              columns={columns}
              assigneeId={String(assigneeId ?? '')}
              setAssigneeId={setAssigneeId}
              managerId={String(managerId ?? '')}
              setManagerId={setManagerId}
              deadline={deadline}
              setDeadline={setDeadline}
              participants={participants}
              addPerson={(id, role) => void addPerson(id, role)}
              removePerson={(id, role) => void removePerson(id, role)}
              approval={approval}
              moving={moving}
              onStatus={(id) => void moveToColumn(id)}
              priority={String(priority ?? 'normal')}
              setPriority={setPriority}
              projectName={projectName}
              repeatLabel={task.recurrence_id ? repeatLabel : null}
              clientName={clientName}
              showClient={CLIENTS_ENABLED}
              onOpenTab={(t) => pickTab(t)}
              suggest={<SuggestAssignee title={title} description={desc} projectId={String(task.project_id)} onPick={setAssigneeId} />}
            />

            {/* a-4. Все кнопки действий одной строкой (ТЗ п. 4) */}
            <div className="ts-actions">
              {targets.length > 0 && (
                <div className="tv2-split ts-finish">
                  {doneTarget ? (
                    <>
                      <Button variant="primary" size="sm" onClick={() => moveToColumn(doneTarget.id)} loading={moving} title={`Завершить и перенести в «${doneTarget.name}»`}>
                        <Icon name="check" size={15} /> Завершить
                      </Button>
                      <DropdownMenu
                        align="start"
                        trigger={(
                          <Button variant="primary" size="sm" className="tv2-split-more" disabled={moving} aria-label="Ещё варианты завершения">
                            <Icon name="chevron-down" size={14} />
                          </Button>
                        )}
                      >
                        {targets.map((c) => (
                          <MenuItem key={c.id} onSelect={() => void moveToColumn(c.id)} icon={c.highlight ? <Icon name="check" size={14} /> : undefined}>{c.name}</MenuItem>
                        ))}
                        {hasFinishExtras && <MenuSeparator />}
                        {finishExtras}
                      </DropdownMenu>
                    </>
                  ) : (
                    // «Готово» у проекта нет (импортные доски) — колонку человек выбирает сам.
                    <DropdownMenu
                      align="start"
                      trigger={(
                        <Button variant={isDone ? 'outline' : 'primary'} size="sm" loading={moving}>
                          {isDone ? <><Icon name="reply" size={15} /> Вернуть в работу</> : <><Icon name="check" size={15} /> Завершить</>}
                          <Icon name="chevron-down" size={14} />
                        </Button>
                      )}
                    >
                      {targets.map((c) => (
                        <MenuItem key={c.id} onSelect={() => void moveToColumn(c.id)} icon={c.highlight ? <Icon name="check" size={14} /> : undefined}>{c.name}</MenuItem>
                      ))}
                      {hasFinishExtras && <MenuSeparator />}
                      {finishExtras}
                    </DropdownMenu>
                  )}
                </div>
              )}
              {/* Таймер одной кнопкой: «▶ Начать 0:00», пока идёт — «❚❚ Пауза» и время */}
              <Button
                size="sm"
                variant="outline"
                className={`ts-timer${timerActive ? ' is-running' : ''}`}
                onClick={() => onToggleTimer(task.id)}
                title={timerActive ? 'Поставить таймер на паузу' : 'Начать работу — пойдёт таймер'}
                aria-label={timerActive ? `Пауза, учтено ${clock(time.totalSec)}` : `Начать, учтено ${clock(time.totalSec)}`}
              >
                <Icon name={timerActive ? 'pause' : 'play'} size={14} /> {timerActive ? 'Пауза' : 'Начать'}
                <span className="ts-timer-t">{clock(time.totalSec)}</span>
              </Button>
              {!task.closed_at && (
                <Button size="sm" variant="outline" className="ts-opt" onClick={() => setBlockerOpen(true)} title="Работа не может продолжаться: укажите причину и кто поможет">
                  <Icon name="ban" size={14} /> {task.is_blocked ? 'Изменить препятствие' : 'Есть препятствие'}
                </Button>
              )}
              {/* Проверка ИИ: читает постановку, чек-лист, переписку и вложения, отчёт — в обсуждение. */}
              <Button size="sm" variant="outline" className="ts-opt" onClick={runReview} loading={reviewing} disabled={moving}
                title="ИИ прочитает задачу, посмотрит вложения и напишет в обсуждение, что проверил">
                {!reviewing && <Icon name="sparkles" size={14} />} {reviewing ? 'Проверяю…' : 'Проверить ИИ'}
              </Button>
              {canShare && (
                <Button size="sm" variant="outline" className="ts-opt" onClick={() => setShareOpen(true)} title="Показать результат клиенту по ссылке: согласовать или попросить изменения">
                  <Icon name="link" size={14} /> Отправить клиенту
                </Button>
              )}
              <DropdownMenu trigger={<Button variant="ghost" size="icon-sm" aria-label="Ещё действия с задачей" title="Ещё действия"><Icon name="more" size={16} /></Button>}>
                {moreItems(narrow)}
              </DropdownMenu>
            </div>

            {err && <div className="tv2-callout tv2-callout-danger" role="alert"><Icon name="alert" size={15} /> {err}</div>}
            {warn && (
              <div className="tv2-callout tv2-callout-warn">
                <Icon name="alert" size={15} />
                <span>Перегруз: риск {warn.riskPct ?? '—'}%, {warn.projectedHours} ч &gt; {warn.capacityHours} ч/нед.</span>
                <Button size="sm" variant="outline" onClick={() => saveAll(true)}>Всё равно назначить</Button>
              </div>
            )}
            {shiftNote && <div className="tv2-note"><Icon name="check" size={13} /> {shiftNote}</div>}
            {tplNote && <div className="tv2-note"><Icon name="check" size={13} /> {tplNote}</div>}

            {/* Просьба перенести срок — по тем же правилам, что приёмка: видно всем, кнопки — тому, кто решает. */}
            {task.deadline_shift_to && !shiftDecided && (
              <div className="tv2-callout tv2-callout-warn tv2-callout-block">
                <div className="tv2-callout-head">
                  <Icon name="calendar" size={15} />
                  {userName(task.deadline_shift_by ?? null)} отчитался «Сделал» и просит перенести срок
                  на {shiftLabel(task.deadline_shift_to)}
                </div>
                {isManager ? (
                  <div className="tv2-callout-actions">
                    <Button variant="primary" size="sm" onClick={() => decideShift(true)}>Подтвердить</Button>
                    <Button variant="outline" size="sm" onClick={() => decideShift(false)}>Оставить прежний срок</Button>
                  </div>
                ) : (
                  <div className="tv2-callout-sub">Решает {userName(task.created_by ?? null)} — до подтверждения срок прежний.</div>
                )}
              </div>
            )}

            {/* Работа сдана и ждёт решения: адресовано конкретному человеку. */}
            {task.approval_state === 'pending' && (
              <div className="tv2-callout tv2-callout-warn tv2-callout-block">
                <div className="tv2-callout-head">
                  <Icon name="alert" size={15} /> Работа сдана и ждёт решения постановщика
                </div>
                {isManager ? (
                  <div className="tv2-callout-actions">
                    <Button variant="primary" size="sm" onClick={() => decide(true)}>Принять работу</Button>
                    <Button variant="outline" size="sm" onClick={() => decide(false)}>Вернуть в работу</Button>
                  </div>
                ) : (
                  <div className="tv2-callout-sub">Решает {userName(task.created_by ?? null)} — задача завершится после подтверждения.</div>
                )}
              </div>
            )}

            <FlowNotices task={task} flow={flow} onRefresh={onRefresh} onOpenChat={() => setChatOpen(true)} />

            {/* a-5. Описание: сразу под кнопками, длинное — свёрнуто до 200 px (ТЗ п. 5) */}
            <section className="ts-card ts-desc-card">
              <div className="ts-card-h">
                <h3>Описание</h3>
                <span className="ts-sp" />
                <button type="button" className="ts-link" onClick={() => setEditingDesc((v) => !v)}
                  title={editingDesc ? 'Закончить правку — описание сохраняется само' : 'Изменить описание'}>
                  <Icon name={editingDesc ? 'check' : 'edit'} size={13} /> {editingDesc ? 'Готово' : 'Редактировать'}
                </button>
              </div>
              {/* Визуальный редактор: жирный, списки, картинки по Ctrl+V. В базу уходит
                  лёгкая разметка, поэтому письма и ИИ читают описание как раньше. */}
              {editingDesc ? (
                <div className="ts-desc">
                  <RichEditor
                    value={desc}
                    onChange={setDesc}
                    onUploadImage={uploadDescImage}
                    busy={descBusy}
                    autoFocus
                    placeholder="Что нужно сделать. Картинку можно вставить из буфера (Ctrl+V)"
                  />
                </div>
              ) : (
                <>
                  <div className={`ts-desc${descTall && !descOpen ? ' is-clipped' : ''}`}>
                    <div ref={descBodyRef}>
                      <TaskDescription text={desc} onEmptyClick={() => setEditingDesc(true)} onEdit={() => setEditingDesc(true)} onOpenImage={setDescPreview} />
                    </div>
                  </div>
                  {descTall && (
                    <button type="button" className="ts-more" onClick={() => setDescOpen((v) => !v)} aria-expanded={descOpen}>
                      {descOpen ? 'Свернуть ↑' : 'Развернуть полностью ↓'}
                    </button>
                  )}
                </>
              )}
              {descPreview && (
                <Lightbox items={[{ url: descPreview.url, name: descPreview.name, mime: descPreview.mime }]} onClose={() => setDescPreview(null)} />
              )}
              {(meeting || fromMessage) && (
                <div className="ts-desc-foot">
                  {meeting && (
                    // Обратная ссылка: из задачи видно, на какой встрече её поручили
                    <div className="tv2-origin">
                      <Icon name="record" size={13} /> Создано по итогам встречи:{' '}
                      <button className="link-btn" onClick={() => navigate({ section: 'chat', view: 'meetings', meetingId: meeting.meeting_id })}>
                        {meeting.title || 'встреча'}
                      </button>
                      {meeting.happened_at && <span className="dim"> · {new Date(meeting.happened_at).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}</span>}
                      {meeting.source_sec != null && (
                        // ТЗ-22, §18: «Открыть момент 31:14» — где именно это поручили
                        <>
                          {' · '}
                          <button className="link-btn" onClick={() => navigate(`/meetings/${encodeURIComponent(meeting.meeting_id)}?t=${Math.round(Number(meeting.source_sec))}`)}>
                            открыть момент {Math.floor(Number(meeting.source_sec) / 60)}:{String(Math.floor(Number(meeting.source_sec) % 60)).padStart(2, '0')}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                  {/* фрагмент записи — у задач со встречи и из голосового в чате (ТЗ-25, ТЗ-26) */}
                  <Suspense fallback={null}>
                    <TaskAudioProof taskId={String(task.id)} canEdit={isManager || user?.role === 'manager'} />
                  </Suspense>
                  {fromMessage && (
                    // «а это вообще откуда?» — самый частый вопрос на разборе через неделю после постановки
                    <div className="tv2-origin">
                      {task.created_by_ai
                        ? <><Icon name="sparkles" size={13} /> Создано QEVO AI по итогам переписки{' '}</>
                        : <><Icon name="chat" size={13} /> Создано из сообщения{' '}</>}
                      {fromMessage.author_name ? `(${fromMessage.author_name})` : ''}:{' '}
                      <button
                        className="link-btn"
                        onClick={() => {
                          navigate({ section: 'chat', chatId: String(fromMessage.chat_id) });
                          window.setTimeout(() => window.dispatchEvent(new CustomEvent('teamcrm:chat-jump', {
                            detail: { chatId: String(fromMessage.chat_id), messageId: String(fromMessage.message_id) },
                          })), 300);
                        }}
                        title={fromMessage.body}
                      >
                        «{sourceOpen || fromMessage.body.length <= 80 ? fromMessage.body : `${fromMessage.body.slice(0, 80).trimEnd()}…`}»
                      </button>
                      {fromMessage.body.length > 80 && (
                        <>{' '}<button className="link-btn" aria-expanded={sourceOpen} onClick={() => setSourceOpen((v) => !v)}>{sourceOpen ? 'Свернуть' : 'Ещё'}</button></>
                      )}
                      {/* Отзыв о задаче, которую завёл агент (ТЗ-12), и отмена его ошибки: окно — сутки. */}
                      {task.created_by_ai && <>{' · '}<AiFeedback send={(b) => api.aiTaskFeedback(task.id, b)} /></>}
                      {task.created_by_ai
                        && (!task.created_at || Date.now() - new Date(task.created_at).getTime() < 24 * 3600_000) && (
                        <>{' · '}<button className="link-btn" disabled={moving} onClick={() => void undoAi()}>Отменить — агент ошибся</button></>
                      )}
                    </div>
                  )}
                </div>
              )}
            </section>

            {/* a-6. Одна полоса табов; содержимое — прямо под ней (ТЗ п. 6) */}
            <section className="ts-card ts-tabs-card">
              <TaskTabBar items={tabItems} value={pane} onChange={pickTab} />
              <div className="ts-pane" role="tabpanel">
                {pane === 'checklist' && (
                  <ChecklistTab
                    taskId={task.id}
                    onRefresh={onRefresh}
                    required={task.checklist_required !== false}
                    shotsRequired={task.shots_required !== false}
                    canSetRequired={isManager || user?.role === 'manager'}
                    onCount={(done, total) => setChecks({ done, total })}
                  />
                )}
                {pane === 'files' && <FilesTab taskId={task.id} onRefresh={onRefresh} onCount={setFileCount} />}
                {pane === 'links' && (
                  <div className="ts-links">
                    {/* #4846: подзадачи и родительская задача — как в Битрикс24 */}
                    <TaskFamily task={task} columns={columns} users={users} onRefresh={onRefresh} />
                    <LinksRows task={task} flow={flow} onRefresh={onRefresh} />
                  </div>
                )}
                {pane === 'repeat' && <RecurrencePane taskId={String(task.id)} onRefresh={onRefresh} onSaved={setRepeatLabel} />}
                {pane === 'time' && (
                  <>
                    <div className="ts-row">
                      <span className="ts-k">Оценка, ч</span>
                      <Input type="number" min="0" step="0.5" className="ts-input ts-input-num" value={estimate} placeholder="не задана" onChange={(e) => setEstimate(e.target.value)} aria-label="Оценка, часов" />
                    </div>
                    <div className="ts-row">
                      <span className="ts-k">Потрачено</span>
                      <span>{spentWords(time.totalSec)} · {timerActive ? 'таймер идёт' : 'таймер остановлен'}</span>
                    </div>
                    <div className="ts-row">
                      <span className="ts-k">Запланировать время</span>
                      <span>
                        {!task.closed_at
                          ? <button type="button" className="ts-link" onClick={() => planTime(String(task.id))} title="В календаре появится блок со ссылкой на задачу. Срок не меняется"><Icon name="calendar" size={13} /> выбрать слот в календаре</button>
                          : <span className="ts-faint">задача завершена</span>}
                        {!task.closed_at && flow.isDoer && !flow.inFocus && <>{' · '}<button type="button" className="ts-link" onClick={() => setFocusOpen(true)}><Icon name="target" size={13} /> начать фокус</button></>}
                      </span>
                    </div>
                    {flowTimeRows(task, columns).map((r) => (
                      <div key={r.k} className="ts-row"><span className="ts-k">{r.k}</span><span>{r.v}</span></div>
                    ))}
                    {(task.risk_level || task.predicted_finish_at) && (
                      <div className="ts-row">
                        <span className="ts-k">Прогноз</span>
                        <span>
                          {task.risk_level && <span className={`risk-dot risk-${task.risk_level}`} />}
                          {task.risk_level ? `риск ${task.risk_pct ?? '—'}%` : 'без оценки риска'}
                          {task.predicted_finish_at && ` · закончится ${new Date(task.predicted_finish_at).toLocaleString('ru-RU')}`}
                        </span>
                      </div>
                    )}
                  </>
                )}
                {pane === 'agent' && (
                  <>
                    <div className="ts-pane-h">
                      <div className="ts-seg" role="tablist" aria-label="Агент или было/стало">
                        <button type="button" role="tab" aria-selected={agentView === 'agent'} className={agentView === 'agent' ? 'is-on' : ''} onClick={() => setAgentView('agent')}>Агент</button>
                        <button type="button" role="tab" aria-selected={agentView === 'ba'} className={agentView === 'ba' ? 'is-on' : ''} onClick={() => setAgentView('ba')}>
                          Было/стало{baNew && <span className="ts-tab-n">1</span>}
                        </button>
                      </div>
                    </div>
                    <div className="ts-pane-body">
                      {agentView === 'agent'
                        ? <AgentTab taskId={task.id} assigned={!!task.agent_assigned} onRefresh={onRefresh} />
                        : (
                          <Suspense fallback={<div className="dim">Загружаю отчёт…</div>}>
                            <BeforeAfterTab taskId={String(task.id)} projectId={String(task.project_id)} autoRun={checkNow} onAutoRunDone={() => setCheckNow(false)} onRefresh={onRefresh} />
                          </Suspense>
                        )}
                    </div>
                  </>
                )}
                {pane === 'params' && (
                  <>
                    <div className="ts-pane-h"><span className="ts-h">Параметры задачи</span><span className="ts-hint">то, что редко меняют</span></div>
                    <div className="ts-row">
                      <span className="ts-k">Приоритет</span>
                      <div className="ts-seg" role="radiogroup" aria-label="Приоритет">
                        {PRIORITY_OPTIONS.map((o) => (
                          <button key={o.value} type="button" role="radio" aria-checked={priority === o.value} className={priority === o.value ? 'is-on' : ''} onClick={() => setPriority(o.value)}>{o.label}</button>
                        ))}
                      </div>
                    </div>
                    {/* Перенос в другой проект: «поставил не туда» — переписка, файлы и время едут вместе. */}
                    <div className="ts-row">
                      <span className="ts-k">Проект</span>
                      <div className="ts-v">
                        <Select ariaLabel="Проект задачи" size="sm" value={String(task.project_id)} onValueChange={(v) => { void moveToProject(v); }}
                          options={projectList.map((p) => ({ value: String(p.id), label: p.name }))} className="ts-input" />
                        <span className="ts-meta">{movedNote || 'переписка, вложения и время переедут вместе с задачей'}</span>
                      </div>
                    </div>
                    <div className="ts-row">
                      <span className="ts-k">Направления</span>
                      <div className="ts-v"><TaskDirections taskId={String(task.id)} initial={task.directions ?? []} onRefresh={onRefresh} /></div>
                    </div>
                    {CLIENTS_ENABLED && (
                      <div className="ts-row">
                        <span className="ts-k">Клиент</span>
                        <div className="ts-v"><TaskClientField taskId={task.id} clientId={(task as { client_id?: string | null }).client_id ?? null} onChanged={onRefresh} /></div>
                      </div>
                    )}
                    <div className="ts-row">
                      <span className="ts-k">Теги</span>
                      <div className="ts-v"><LabelsRow task={task} onRefresh={onRefresh} /></div>
                    </div>
                    <div className="ts-row">
                      <span className="ts-k">Согласование</span>
                      {/* Переключатель согласования — право постановщика, пока задача жива. */}
                      <Checkbox checked={approval} disabled={!isManager || !!task.closed_at} onCheckedChange={setApproval} label="Не завершать без согласования с постановщиком" />
                    </div>
                    {(task.risk_level || (MONETIZATION_ENABLED && cost !== null)) && (
                      <div className="ts-row">
                        <span className="ts-k">Риск и стоимость</span>
                        <span className="ts-v-inline">
                          {task.risk_level
                            ? <Badge tone={task.risk_level === 'red' ? 'danger' : task.risk_level === 'yellow' ? 'warn' : 'ok'} title="Риск срыва срока"><Icon name="alert" size={11} /> {task.risk_pct ?? '—'}%</Badge>
                            : <span className="ts-faint">нет прогноза</span>}
                          {MONETIZATION_ENABLED && cost !== null && <Badge tone="neutral">₽ {cost.toLocaleString('ru-RU')}</Badge>}
                        </span>
                      </div>
                    )}
                  </>
                )}
                {pane === 'history' && (
                  <>
                    <FlowRecords task={task} flow={flow} />
                    <HistoryRows taskId={String(task.id)} version={task.version} />
                  </>
                )}
              </div>
            </section>
          </>
        )}

        {/* c-7: на телефоне снизу — синяя «Чат задачи» со счётчиком новых */}
        {!chatOpen && (
          <button type="button" className="ts-mchat" onClick={() => setChatOpen(true)}>
            <Icon name="chat" size={16} /> Чат задачи{Number(task.unread ?? 0) > 0 ? ` · ${task.unread} ${plural(Number(task.unread), 'новое', 'новых', 'новых')}` : ''}
          </button>
        )}
        {/* #5029: кнопка «Сохранить» внизу карточки и всегда на виду — автосохранение
            остаётся, а кнопка сохраняет сразу и подтверждает: так спокойнее, чем гадать */}
        {!chatOpen && (
          <div className="ts-savebar">
            <span className="dim" role="status" style={{ fontSize: 'var(--fs-xs)' }}>{saving ? 'Сохраняю…' : 'Правки сохраняются сами'}</span>
            <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" disabled={saving} onClick={() => { void saveAll(false, false); }}>
              <Icon name="check" size={14} /> Сохранить
            </button>
          </div>
        )}
        </div>

        {/* Правая колонка — чат задачи. Он на виду всегда: обсуждение и есть работа по задаче. */}
        <div className="task-chat">
          <TaskChat
            taskId={task.id}
            assigneeId={task.assignee_id}
            creatorId={task.created_by}
            participants={participants}
            onRefresh={onRefresh}
            title={task.title}
            status={columnName}
            projectId={task.project_id}
            onExpand={() => setChatOpen(true)}
          />
        </div>
      </aside>

      {blockerOpen && <BlockerDialog task={task} users={users} onClose={() => setBlockerOpen(false)} onSaved={() => { setBlockerOpen(false); flow.load(); onRefresh(); }} />}
      {handoffTo && (
        <HandoffDialog
          task={task} columnId={handoffTo.id} columnName={handoffTo.name} position={0} users={users}
          canPickReviewer={flow.isBoss || String(task.created_by ?? '') === flow.me}
          onClose={() => setHandoffTo(null)} onDone={() => { setHandoffTo(null); flow.load(); onRefresh(); }}
        />
      )}
      {focusOpen && <TaskFocusDialog preselect={[String(task.id)]} onClose={() => setFocusOpen(false)} onSaved={() => { setFocusOpen(false); flow.loadSession(); }} />}
      {shareOpen && <ShareDialog task={task} onClose={() => setShareOpen(false)} onCreated={() => { setShareOpen(false); flow.load(); }} />}

      {conflict && (
        <ConflictSheet
          item={conflict}
          onClose={() => setConflict(null)}
          onDone={() => { setConflict(null); void flushOffline().finally(onRefresh); }}
        />
      )}

      {saveTpl && (
        <SaveTemplateDialog
          task={task}
          checklistCount={task.checklistTotal ?? 0}
          onClose={() => setSaveTpl(false)}
          onSaved={(name) => setTplNote(`Шаблон «${name}» сохранён — он появится в списке при создании задачи.`)}
        />
      )}

      {merging && (
        <TaskMergeModal
          taskId={String(task.id)}
          taskTitle={task.title}
          onClose={() => setMerging(false)}
          onMerged={(r) => {
            setMerging(false);
            // Уходим в основную задачу: она могла оказаться и в другом проекте.
            navigate({ section: 'projects', projectId: r.projectId, taskId: r.taskId });
            onRefresh();
          }}
        />
      )}
    </div>
  );
}

/**
 * Теги живой задачи.
 *
 * Тем же полем, что и при создании, но в режиме `edit`: подтверждение здесь не нужно
 * (задача уже есть), а подсказки ИИ приходят только по кнопке — молча перетегировать
 * живую задачу после правки названия нельзя, человек этого не просил (ТЗ, п. 39).
 *
 * Сохраняем сразу, набором: «снял один, добавил два» — это одно решение, и при обрыве
 * связи посередине задача не должна остаться размеченной наполовину.
 */
function LabelsRow({ task, onRefresh }: { task: Task; onRefresh: () => void }) {
  const [value, setValue] = useState<TagsValue>({
    ...EMPTY_TAGS,
    tagIds: (task.labels ?? []).map((l: { id: string | number }) => String(l.id)),
  });

  useEffect(() => {
    api.taskTags(task.id)
      .then((items) => setValue({ ...EMPTY_TAGS, tagIds: items.map((t) => String(t.id)) }))
      .catch(() => undefined);
  }, [task.id]);

  const change = (next: TagsValue) => {
    setValue(next);
    api.setTaskTags(task.id, next.tagIds, next.suggested)
      .then(() => onRefresh())
      .catch(() => undefined); // теги — не то, ради чего стоит ронять карточку ошибкой
  };

  return (
    <div className="labels-row">
      <TaskTagsField
        mode="edit"
        task={{ title: task.title, description: task.description ?? undefined }}
        value={value}
        onChange={change}
      />
    </div>
  );
}
/** Направления задачи в карточке: отметили — сохранили, без отдельной кнопки. */
function TaskDirections({ taskId, initial, onRefresh }: { taskId: string; initial: string[]; onRefresh: () => void }) {
  const [value, setValue] = useState<string[]>(initial);
  const [err, setErr] = useState('');
  useEffect(() => { setValue(initial); }, [initial.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const change = async (next: string[]) => {
    const prev = value;
    setValue(next); setErr('');
    try { await api.setTaskDirections(taskId, next); onRefresh(); }
    catch (e) { setValue(prev); setErr(e instanceof ApiError ? e.message : 'Не сохранилось'); }
  };
  return (
    <>
      <DirectionsPicker value={value} onChange={(n) => void change(n)} />
      {err && <div className="error-text">{err}</div>}
    </>
  );
}

function ChecklistTab({ taskId, onRefresh, required, shotsRequired, canSetRequired, onCount }: {
  taskId: string; onRefresh: () => void;
  /** Счётчик на табе «Чек-лист 2/6» — сразу после правки, не дожидаясь доски. */
  onCount?: (done: number, total: number) => void;
  /** Без выполненного чек-листа задачу не сдать (задача #1386). */
  required: boolean;
  /** #4763: без скриншотов результата задачу не сдать. */
  shotsRequired: boolean;
  /** Постановщик или руководство — им решать, обязателен ли чек-лист. */
  canSetRequired: boolean;
}) {
  const [items, setItems] = useState<any[]>([]);
  const [text, setText] = useState('');
  const [strict, setStrict] = useState(required);
  useEffect(() => { setStrict(required); }, [required]);
  const [shots, setShots] = useState(shotsRequired);
  useEffect(() => { setShots(shotsRequired); }, [shotsRequired]);
  const toggleShots = async (on: boolean) => {
    setShots(on);
    try { await api.setShotsRequired(taskId, on); onRefresh(); }
    catch { setShots(!on); }
  };
  const toggleStrict = async (on: boolean) => {
    setStrict(on);
    try { await api.setChecklistRequired(taskId, on); onRefresh(); }
    catch { setStrict(!on); }
  };
  const reload = () => api.listChecklist(taskId).then((list) => {
    setItems(list);
    onCount?.(list.filter((i: { is_done?: boolean }) => i.is_done).length, list.length);
  }).catch(() => undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, [taskId]);
  const done = items.filter((i) => i.is_done).length;
  const addRef = useRef<HTMLInputElement>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  return (
    <>
      {/* #5016: шапка вкладки — шкала «2 из 6» и «+ пункт» справа */}
      <div className="ts-pane-h">
        <span className="ts-h">Чек-лист</span>
        {items.length > 0 && (
          <>
            <span className="ts-progress" aria-label={`Выполнено ${done} из ${items.length}`}><i style={{ width: `${Math.round((done / items.length) * 100)}%` }} /></span>
            <span className="ts-hint">{done} из {items.length}</span>
          </>
        )}
        <span className="ts-sp" />
        {canSetRequired && (
          <button type="button" className="ts-link ts-link-dim" aria-expanded={rulesOpen} onClick={() => setRulesOpen((v) => !v)}>
            <Icon name="lock" size={12} /> Правила сдачи
          </button>
        )}
        <button type="button" className="ts-link" onClick={() => addRef.current?.focus()}><Icon name="plus" size={13} /> пункт</button>
      </div>
      {/*
        Правило видно всем прямо над чек-листом (задача #1386): исполнитель заранее
        знает, что без отмеченных пунктов задачу не сдать, а не узнаёт об этом из возврата.
        Постановщик меняет его по «Правила сдачи».
      */}
      {canSetRequired && rulesOpen && (
        <div className="tv2-rule ts-rules">
          <Checkbox
            checked={strict}
            onCheckedChange={(on) => void toggleStrict(on)}
            label={(
              <span className="tv2-rule-text">
                <b>Не принимать задачу без выполненного чек-листа</b>
                <span>Исполнитель не сможет сдать задачу, пока не отметит все пункты. Включено по умолчанию.</span>
              </span>
            )}
          />
          <Checkbox
            checked={shots}
            onCheckedChange={(on) => void toggleShots(on)}
            label={(
              <span className="tv2-rule-text">
                <b>Просить скриншоты результата</b>
                <span>При сдаче без снимка исполнитель увидит напоминание (сдать всё равно можно — с отметкой в истории). По снимку ИИ и вы проверите результат. Включено по умолчанию.</span>
              </span>
            )}
          />
        </div>
      )}
      {!canSetRequired && ((strict && items.length > 0) || shots) && (
        <div className="ts-note">
          {/* #4952: чек-лист — запрет, скриншоты — просьба постановщика (сдать можно и без них) */}
          <Icon name={strict && items.length > 0 ? 'lock' : 'info'} size={13} /> {[
            strict && items.length > 0 ? 'Задачу не сдать, пока не отмечены все пункты чек-листа — так решил постановщик.' : '',
            shots ? 'Постановщик просит приложить скриншоты результата.' : '',
          ].filter(Boolean).join(' ')}
        </div>
      )}
      {items.map((i) => (
        <div key={i.id} className={`ts-ci${i.is_done ? ' is-done' : ''}`}>
          <Checkbox
            checked={!!i.is_done}
            onCheckedChange={async () => {
              if (!i.is_done) feedback('task.checked');
              await api.patchChecklist(taskId, i.id, { isDone: !i.is_done }); reload(); onRefresh();
            }}
            label={i.text}
          />
          <Button variant="ghost" size="icon-sm" className="ts-row-del" onClick={async () => { await api.deleteChecklist(taskId, i.id); reload(); onRefresh(); }} title="Удалить пункт" aria-label={`Удалить пункт «${i.text}»`}>
            <Icon name="trash" size={14} />
          </Button>
        </div>
      ))}
      {items.length === 0 && <div className="ts-empty">Чек-листа нет — разбейте задачу на шаги: станет видно, сколько уже сделано.</div>}
      <form
        className="ts-ci ts-add"
        onSubmit={async (e) => { e.preventDefault(); if (!text.trim()) return; await api.addChecklist(taskId, text.trim()); setText(''); reload(); onRefresh(); }}
      >
        <Input ref={addRef} className="ts-input" placeholder="Новый пункт — Enter, чтобы добавить" value={text} onChange={(e) => setText(e.target.value)} aria-label="Новый пункт чек-листа" />
        <Button type="submit" size="sm" variant="primary" disabled={!text.trim()}><Icon name="plus" size={14} /> Добавить</Button>
      </form>
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
    if (!(await confirmAction({
      title: 'Передать задачу ИИ-агенту?',
      description: 'Он станет исполнителем и сразу выполнит её — результат появится в «На тестировании».',
      confirmLabel: 'Передать',
    }))) return;
    setBusy(true); setMsg('');
    try {
      const r = await api.agentAssign(taskId, true, runOpts());
      feedback('ai.completed');
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
    running: { label: 'выполняется', cls: 'ui-badge-info' },
    done: { label: 'на ревью', cls: 'ui-badge-warn' },
    accepted: { label: 'принят', cls: 'ui-badge-ok' },
    rejected: { label: 'отклонён', cls: 'ui-badge-neutral' },
    declined: { label: 'не автоматизируется', cls: 'ui-badge-neutral' },
    failed: { label: 'ошибка', cls: 'ui-badge-danger' },
  } as Record<string, { label: string; cls: string }>)[s] ?? { label: s, cls: 'ui-badge-neutral' });

  const run = async () => {
    setBusy(true); setMsg('');
    try { await api.agentRun(taskId); feedback('ai.completed'); flash('Готово — черновик ниже и в обсуждении задачи'); reload(); onRefresh(); }
    catch (e) { feedback('error'); flash(e instanceof ApiError ? e.message : 'Ошибка запуска агента'); }
    finally { setBusy(false); }
  };
  const execute = async () => {
    if (!(await confirmAction({
      title: 'Выполнить задачу ИИ-агентом?',
      description: 'Он выполнит её и перенесёт в «На тестировании» на вашу проверку.',
      confirmLabel: 'Выполнить',
    }))) return;
    setBusy(true); setMsg('');
    try {
      const r = await api.agentExecute(taskId, runOpts());
      feedback(r.declined ? 'warning' : 'ai.completed');
      flash(r.declined
        ? 'Задача требует человека — агент не может её выполнить (см. пояснение ниже)'
        : `Выполнено${r.fileName ? ' — файл во вкладке «Файлы»' : ''}${r.movedTo ? `, задача в «${r.movedTo}»` : ''}`);
      reload(); onRefresh();
    } catch (e) { feedback('error'); flash(e instanceof ApiError ? e.message : 'Ошибка выполнения'); }
    finally { setBusy(false); }
  };
  const accept = async (id: string, toChecklist: boolean) => {
    try { const r = await api.agentAccept(id, toChecklist); fx('action.confirmed'); flash(toChecklist ? `Принято, добавлено пунктов: ${r.addedChecklist}` : 'Результат принят'); reload(); onRefresh(); }
    catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); }
  };
  const reject = async (id: string) => {
    try { await api.agentReject(id); flash('Отклонено'); reload(); onRefresh(); }
    catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); }
  };
  const rework = async (id: string) => {
    const feedback = await promptText({
      title: 'Доработать результат агента',
      description: 'Агент переделает результат с учётом замечаний.',
      minLength: 2,
      confirmLabel: 'Доработать',
    });
    if (!feedback || feedback.trim().length < 2) return;
    setBusy(true); setMsg('');
    try { await api.agentRework(id, feedback.trim()); fx('ai.completed'); flash('Доработка готова — новый результат ниже'); reload(); onRefresh(); }
    catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка доработки'); }
    finally { setBusy(false); }
  };
  const kindLabel = (k: string) => (k === 'task_execute' ? 'выполнение' : k === 'task_rework' ? 'доработка' : 'черновик');

  return (
    <>
      <div className="add-area" style={{ marginBottom: 10 }}>
        {assigned ? (
          <div className="tv2-row">
            <Badge tone="info"><Icon name="robot" size={11} /> Исполнитель — ИИ-агент</Badge>
            <Button variant="ghost" size="sm" onClick={unassign} disabled={busy}>Снять с агента</Button>
          </div>
        ) : (
          <Button variant="primary" className="tv2-wide" onClick={assign} loading={busy}>
            <Icon name="robot" size={15} /> Передать агенту
          </Button>
        )}
        <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>
          «Передать агенту» — назначить ИИ исполнителем и сразу выполнить (текстовые задачи). Задача пойдёт в «На тестировании» вам на проверку.
        </div>
      </div>
      <div className="dim" style={{ fontSize: 12 }}>
        Разовые запуски: <b>Черновик</b> — предложит план (ничего не меняет).
        <b> Выполнить</b> — готовый результат → «На тестировании». Не устроило — «Доработать» с замечаниями.
      </div>

      {/* выбор промпта: пресет из библиотеки / свой / по умолчанию */}
      <div style={{ marginTop: 8 }}>
        <Select
          ariaLabel="Промпт для агента"
          className="tv2-wide"
          value={promptId}
          onValueChange={setPromptId}
          options={[
            { value: '', label: 'Промпт: по умолчанию' },
            ...prompts.map((p) => ({ value: String(p.id), label: `${p.name}${p.is_shared ? ' · общий' : ''}${p.model ? ` · ${p.model}` : ''}` })),
            { value: '__custom__', label: 'Свой промпт…' },
          ]}
        />
        {promptId === '__custom__' && (
          <>
            <textarea className="ui-textarea" rows={3} style={{ marginTop: 6 }} placeholder="Инструкция агенту на этот запуск: роль, тон, структура…" value={customText} onChange={(e) => setCustomText(e.target.value)} />
            <div style={{ marginTop: 6 }}>
              <Select
                ariaLabel="Модель"
                className="tv2-wide"
                value={customModel}
                onValueChange={setCustomModel}
                options={[{ value: '', label: 'Модель по умолчанию' }, ...models.map((m) => ({ value: m, label: `${m}${m.endsWith(':free') ? ' — бесплатно' : ''}` }))]}
              />
            </div>
            <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>Совет: удачный промпт сохраните в «Личный кабинет → Профиль → Мои промпты», чтобы переиспользовать.</div>
          </>
        )}
      </div>
      <div className="team-rate" style={{ marginTop: 8 }}>
        <Button variant="outline" style={{ flex: 1 }} onClick={run} disabled={busy}>
          {busy ? 'Агент думает…' : <><Icon name="sparkles" size={15} /> Черновик</>}
        </Button>
        <Button variant="primary" style={{ flex: 1 }} onClick={execute} loading={busy} title="Автономно выполнить задачу (текст/КП) → на тестирование">
          {busy ? 'Агент работает…' : <><Icon name="robot" size={15} /> Выполнить</>}
        </Button>
      </div>
      {msg && <div className="dim" style={{ marginTop: 6 }}>{msg}</div>}
      {runs.map((r) => (
        <div key={r.id} className="team-row" style={{ marginTop: 8 }}>
          <div className="team-head">
            <span className={`ui-badge ${statusBadge(r.status).cls}`}>{statusBadge(r.status).label}</span>
            <span className="dim" style={{ fontSize: 12 }}>
              {kindLabel(r.kind)} · {new Date(r.created_at).toLocaleString('ru-RU')}
              {(r.input_tokens || r.output_tokens) ? ` · ~${(r.input_tokens || 0) + (r.output_tokens || 0)} ток.` : ''}
            </span>
          </div>
          {r.result && <div className="dim" style={{ whiteSpace: 'pre-wrap', fontSize: 12, maxHeight: 220, overflow: 'auto', margin: '4px 0' }}>{r.result}</div>}
          {r.error && <div className="error-text" style={{ fontSize: 12 }}>{r.error}</div>}
          {(r.status === 'done' || (r.status === 'accepted' && (r.kind === 'task_execute' || r.kind === 'task_rework'))) && (
            <div className="team-rate">
              {r.status === 'done' && <Button variant="primary" size="sm" onClick={() => accept(r.id, false)}>Принять</Button>}
              {r.status === 'done' && r.kind === 'task_draft' && <Button variant="outline" size="sm" onClick={() => accept(r.id, true)}>В чек-лист</Button>}
              {(r.kind === 'task_execute' || r.kind === 'task_rework') && <Button variant="outline" size="sm" onClick={() => rework(r.id)} disabled={busy} title="Вернуть на доработку с замечаниями"><Icon name="refresh" size={14} /> Доработать</Button>}
              {r.status === 'done' && <Button variant="ghost" size="sm" onClick={() => reject(r.id)}>Отклонить</Button>}
            </div>
          )}
        </div>
      ))}
    </>
  );
}

function FilesTab({ taskId, onRefresh, onCount }: { taskId: string; onRefresh: () => void; onCount?: (n: number) => void }) {
  const [files, setFiles] = useState<any[]>([]);
  const [preview, setPreview] = useState<{ url: string; name: string; mime: string; own?: boolean } | null>(null);
  const [err, setErr] = useState('');
  /**
   * Что сейчас происходит с файлами.
   *
   * Загрузка шла молча: человек выбирал файл, окно ничего не отвечало, и понять,
   * прикрепился он или нет, было нельзя — ровно это и было замечанием. Теперь виден
   * и сам ход загрузки, и её итог.
   */
  const [busyName, setBusyName] = useState('');
  const [done, setDone] = useState('');
  const reload = () => api.listAttachments(taskId).then((list) => {
    setFiles(list);
    onCount?.(list.length);
  }).catch(() => undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, [taskId]);
  // подтверждение гаснет само: постоянная зелёная строка перестаёт что-либо значить
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => setDone(''), 4000);
    return () => window.clearTimeout(t);
  }, [done]);
  const upload = async (list: FileList | null) => {
    const picked = Array.from(list ?? []);
    if (!picked.length) return;
    setErr(''); setDone('');
    const failed: string[] = [];
    // #4887: файл в созданной задаче — сообщением в чат (виден в переписке) и во «Файлах»;
    // пачками по десять — столько берёт одно сообщение, сервер грузит их по порядку
    for (let i = 0; i < picked.length; i += 10) {
      const part = picked.slice(i, i + 10);
      setBusyName(part.map((f) => f.name).join(', '));
      // #4664: причина рядом с именем — «не загрузились» без «почему» не исправить
      try { await api.addCommentFile(taskId, part, ''); } catch (e) { failed.push(e instanceof ApiError ? `${part.map((f) => f.name).join(', ')} (${e.message})` : part.map((f) => f.name).join(', ')); }
    }
    setBusyName('');
    await reload();
    onRefresh();
    if (failed.length) setErr(`Не загрузились: ${failed.join(', ')}. Попробуйте ещё раз.`);
    else setDone(picked.length === 1 ? `Файл «${picked[0].name}» прикреплён — он и в чате задачи` : `Прикреплено файлов: ${picked.length} — они и в чате задачи`);
  };
  // файлы за авторизацией: тянем blob с токеном, картинку показываем в попапе, остальное скачиваем
  /** Какое вложение сейчас открывается и на сколько процентов (-1 — размер неизвестен). */
  const [opening, setOpening] = useState<{ id: string; pct: number } | null>(null);
  const open = async (f: any) => {
    setErr('');
    if (opening) return;
    setOpening({ id: String(f.file_id), pct: -1 });
    try {
      const blob = await api.authedBlobProgress(`/api/files/${f.file_id}`, (p) => setOpening({ id: String(f.file_id), pct: p ?? -1 }));
      const url = URL.createObjectURL(blob);
      if (blob.type.startsWith('image/') || blob.type.startsWith('video/')) {
        setPreview({ url, name: f.file_name, mime: blob.type, own: true });
      } else {
        const a = document.createElement('a');
        a.href = url; a.download = f.file_name; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось открыть файл');
    } finally { setOpening(null); }
  };
  const closePreview = () => {
    // Ссылку освобождаем только свою: у превью из AuthedMedia хозяин другой, и
    // отозванный блоб оставил бы вместо картинки битый значок.
    if (preview?.own) URL.revokeObjectURL(preview.url);
    setPreview(null);
  };
  /** Что показать глазами: картинки и видео. Документы остаются строкой со скачиванием. */
  const media = files.filter((f: any) => {
    const t = String(f.content_type ?? '');
    return t.startsWith('image/') || t.startsWith('video/');
  });
  const pickRef = useRef<HTMLInputElement>(null);
  const [docBusy, setDocBusy] = useState('');
  /** «Создать документ ▾»: Google-документ, таблица или презентация при задаче — откроется в новой вкладке. */
  const createDoc = async (format: 'doc' | 'sheet' | 'slides', label: string) => {
    setErr(''); setDocBusy(label);
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    try {
      const r = await google.createDoc('task', String(taskId), false, format);
      if (tab) tab.location.href = r.url; else window.open(r.url, '_blank', 'noopener');
      setDone(`${label} создан(а) и прикреплен(а) — ниже, в «Google Диск»`);
      setGkey((k) => k + 1);
    } catch (e) {
      tab?.close();
      setErr(e instanceof ApiError ? e.message : `Не удалось создать: ${label.toLowerCase()}. Подключите Google Диск в блоке ниже`);
    } finally { setDocBusy(''); }
  };
  const [gkey, setGkey] = useState(0);
  const when = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); void upload(e.dataTransfer.files); }}
    >
      <div className="ts-pane-h">
        <span className="ts-h">Файлы{files.length ? ` · ${files.length}` : ''}</span>
        <span className="ts-sp" />
        <button type="button" className="ts-link" onClick={() => pickRef.current?.click()}><Icon name="plus" size={13} /> Загрузить</button>
        <input ref={pickRef} className="file-pick-input" type="file" multiple aria-label="Загрузить файлы в задачу" hidden
          onChange={(e) => { void upload(e.target.files); e.target.value = ''; }} />
        <DropdownMenu trigger={<button type="button" className="ts-link" disabled={!!docBusy}>{docBusy ? `Создаю…` : 'Создать документ'} <Icon name="chevron-down" size={12} /></button>}>
          <MenuItem onSelect={() => void createDoc('doc', 'Документ')} icon={<Icon name="file" size={14} />}>Документ</MenuItem>
          <MenuItem onSelect={() => void createDoc('sheet', 'Таблица')} icon={<Icon name="columns" size={14} />}>Таблица</MenuItem>
          <MenuItem onSelect={() => void createDoc('slides', 'Презентация')} icon={<Icon name="chart" size={14} />}>Презентация</MenuItem>
        </DropdownMenu>
      </div>
      {busyName && <div className="ts-note"><span className="ui-spinner" style={{ width: 13, height: 13 }} /> Загружаю «{busyName}»…</div>}
      {done && <div className="ts-note file-ok"><Icon name="check" size={13} /> {done}</div>}
      {err && <div className="ts-note error-text">{err}</div>}
      {/*
        Картинки и видео показываем сразу, а не строкой с именем файла: запись из чата
        выглядела как «Видео-08-09.mp4», и человек считал, что она не приложилась.
      */}
      {media.length > 0 && (
        <div className="task-media ts-media">
          {media.map((f) => (
            <AuthedMedia key={f.id} fileId={String(f.file_id)} name={f.file_name} mime={String(f.content_type ?? '')} onOpen={(p) => setPreview(p)} />
          ))}
        </div>
      )}
      {files.map((f) => (
        <div key={f.id} className="ts-file">
          <FileTypeIcon name={String(f.file_name ?? '')} mime={String(f.content_type ?? '')} />
          <div className="ts-file-main">
            <button className="file-link ts-file-name" onClick={() => open(f)} aria-busy={opening?.id === String(f.file_id)} title={f.file_name}>{f.file_name}</button>
            <div className="ts-meta">
              {[f.uploaded_by_name, f.created_at ? when(f.created_at) : '', fileSize(f.size_bytes)].filter(Boolean).join(' · ')}
              {opening?.id === String(f.file_id) && <> · <span className="spin-sm" /> {opening.pct < 0 ? 'открываю…' : `${opening.pct}%`}</>}
            </div>
          </div>
          <span className="ts-file-acts">
            <button type="button" className="ts-link" onClick={() => open(f)}>Открыть</button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Удалить файл ${f.file_name}`}
              title="Удалить файл"
              onClick={async () => {
                if (!(await confirmAction({ title: `Удалить файл «${f.file_name}»?`, description: 'Из задачи он пропадёт у всех участников.', danger: true }))) return;
                await api.deleteAttachment(taskId, f.id); await reload(); onRefresh();
              }}
            >
              <Icon name="trash" size={14} />
            </Button>
          </span>
        </div>
      ))}
      {files.length === 0 && <div className="ts-empty">Файлов нет — перетащите их сюда или нажмите «Загрузить». Они будут видны всем участникам.</div>}
      {/* файлы Google Диска и документ по задаче (#1565) — рядом с обычными файлами */}
      <div className="ts-gfiles"><GoogleFilesBlock key={gkey} entityType="task" entityId={String(taskId)} /></div>
      {preview && <Lightbox items={[{ url: preview.url, name: preview.name, mime: preview.mime }]} onClose={closePreview} />}
    </div>
  );
}

/**
 * Описание задачи в режиме чтения.
 *
 * Ссылки кликаются, картинки видны, текст выделяется и копируется — всё то, чего
 * нельзя было сделать, пока описание всегда было полем ввода. Разметка та же, что
 * пишет редактор (lib/rich-text); плоский текст старых задач проходит как был.
 */
function TaskDescription({ text, onEmptyClick, onEdit, onOpenImage }: {
  text: string;
  onEmptyClick: () => void;
  /** Нажатие на сам текст — править (#1554: на телефоне маленькую кнопку не находили). */
  onEdit?: () => void;
  onOpenImage?: (p: { url: string; name: string; mime: string }) => void;
}) {
  const body = String(text ?? '');
  if (!body.trim()) {
    return (
      <button className="desc-empty" onClick={onEmptyClick}>
        Описания нет — нажмите, чтобы добавить
      </button>
    );
  }
  return (
    <div
      className="task-desc-tap"
      title="Нажмите на текст, чтобы изменить"
      onClick={(e) => {
        // ссылка, картинка, флажок — у них своё действие; выделяют текст — не мешаем
        if ((e.target as HTMLElement).closest('a, img, button, input, video, audio')) return;
        if (window.getSelection()?.toString()) return;
        onEdit?.();
      }}
    >
      <RichText text={body} className="task-desc" onOpenImage={onOpenImage} />
    </div>
  );
}
