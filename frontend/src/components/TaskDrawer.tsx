import { useEffect, useRef, useState, type ReactNode } from 'react';
import { TaskClientField } from './TaskClientField';
import { navigate } from '../lib/router';
import { useAuth } from '../state/auth';
import { EmptyState } from './EmptyState';
import { Icon } from './Icon';
import { SaveTemplateDialog } from './SaveTemplateDialog';
import { GateBlock, HandoffGateDialog, gateFromError } from './HandoffGateDialog';
import { api, ApiError, QUEUED } from '../lib/api';
import { enqueueConflict, newChangeId, type QueuedChange } from '../lib/offline-queue';
import { flushOffline } from '../hooks/useOfflineQueue';
import { ConflictSheet } from './OfflineBar';
import type { Task, User } from '../types';
import { Lightbox } from './Lightbox';
import { DatePicker } from './DatePicker';
import { TaskChat } from './TaskChat';
import { TaskRecurrenceBlock } from './TaskRecurrence';
import { TaskMergeModal } from './TaskMergeModal';
import { AuthedMedia } from './AuthedMedia';
import { RichText } from './RichText';
import { RichEditor } from './RichEditor';
import { SuggestAssignee } from './SuggestAssignee';
import { DirectionsPicker } from './DirectionsPicker';
import { CLIENTS_ENABLED, MONETIZATION_ENABLED } from '../config';
import { TaskTagsField } from './TaskTagsField';
import { EMPTY_TAGS, TagsValue } from '../lib/tags';
import { overlayProps } from '../lib/overlay';
import { showToast, toastSaved } from '../lib/notifications';
import { AiFeedback } from './AiFeedback';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { confirmAction, promptText } from './ui/dialog';
import { DropdownMenu, MenuItem, MenuSeparator } from './ui/dropdown-menu';
import { Field } from './ui/field';
import { Input } from './ui/input';
import { Select } from './ui/select';
import { Tabs } from './ui/tabs';

interface Props {
  task: Task;
  users: User[];
  columns?: { id: string; name: string }[];
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

// Обсуждения среди вкладок больше нет: чат стоит справа и виден всегда.
type Tab = 'overview' | 'checklist' | 'files' | 'agent' | 'chat';
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
  /*
    Срок в поле следует за задачей.

    Поле заполняется один раз при открытии карточки, и после «Сделал» оно продолжало
    показывать прежнюю дату: на экране не менялось ничего, и выходило, что кнопка не
    работает. Подхватываем новый срок — но только если человек сам это поле не правил,
    иначе обновление затрёт то, что он набрал.
  */
  useEffect(() => {
    setDeadline((cur) => (cur === lastServerDeadline.current ? initialDeadline : cur));
    lastServerDeadline.current = initialDeadline;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDeadline]);
  const [warn, setWarn] = useState<any>(null);
  /** Какой срок пришёл с сервера в прошлый раз: по нему видно, правил ли поле человек. */
  const lastServerDeadline = useRef(initialDeadline);
  /** Что ответила кнопка «Сделал»: без строки на экране непонятно, случилось ли хоть что-то. */
  const [shiftNote, setShiftNote] = useState('');
  /** Куда переехала задача — строкой под полем: перенос не должен проходить молча. */
  const [movedNote, setMovedNote] = useState('');
  /** Проекты для переноса: только те, которые человек видит. */
  const [projectList, setProjectList] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => { api.listProjects().then(setProjectList).catch(() => undefined); }, []);
  const [err, setErr] = useState('');
  /** Правка полей столкнулась с чужой (409 по версии): два варианта рядом, решает человек (волна 9). */
  const [conflict, setConflict] = useState<QueuedChange | null>(null);
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
  const [meeting, setMeeting] = useState<{ meeting_id: string; title: string | null } | null>(null);
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
  const saveAll = async (confirmOverload = false) => {
    if (!title.trim()) return setErr('Название не может быть пустым');
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
        if (res.warning && !confirmOverload) { setWarn(res); setSaving(false); return; }
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
        try { await api.updateTask(task.id, patch, task.version); } catch (e) {
          // Сети нет — правка легла в очередь и уйдёт сама; для человека это «сохранено».
          if (e instanceof ApiError && e.code === QUEUED) {
            toastSaved('Сохранится, когда появится сеть');
            return;
          }
          const d = (e instanceof ApiError && e.code === 'CONFLICT' ? e.details : null) as
            { reason?: string; task?: Record<string, unknown>; fields?: string[] } | null;
          if (d?.reason === 'version' && d.task) {
            setConflict(enqueueConflict({
              id: newChangeId(), method: 'PATCH', path: `/tasks/${task.id}`, body: patch,
              ifMatch: task.version ?? null, label: `Правка задачи #${task.id}`,
              preview: String(patch.title ?? patch.description ?? ''),
            }, d.task, d.fields ?? []));
            return;
          }
          throw e;
        }
      }

      if (approval !== initialApproval) await api.setTaskApproval(task.id, approval);

      onRefresh();
      toastSaved('Задача сохранена');
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Ошибка'); }
    finally { setSaving(false); }
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
      await api.decideDeadlineShift(task.id, approve);
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
      if (accept) await api.approveTask(task.id);
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

  // BLOCKED — не правка полей, а метка состояния: её ставят и снимают одним нажатием.
  const toggleBlocked = async () => { await api.updateTask(task.id, { isBlocked: !task.is_blocked }); onRefresh(); };
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
      description: 'Вместе с ней исчезнут комментарии, чек-лист и вложения. Отменить это будет нельзя.',
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
    for (const f of picked) {
      try { await api.uploadAttachment(task.id, f); setFileCount((n) => n + 1); }
      catch (e) { setErr(e instanceof ApiError ? e.message : `Не удалось приложить ${f.name}`); }
    }
    onRefresh();
    toastSaved('Файл приложен', picked.length > 1 ? `${picked.length} шт. — во вкладке «Файлы»` : picked[0].name);
  };

  const userOptions = (empty: string) => [
    { value: '', label: empty },
    ...users.map((u) => ({ value: String(u.id), label: u.fullName })),
  ];
  const tabItems: { value: Tab; label: ReactNode; count?: number }[] = [
    { value: 'overview', label: 'Обзор' },
    { value: 'files', label: 'Файлы', count: fileCount },
    { value: 'checklist', label: 'Чек-лист' },
    // ИИ-агент доступен всем сотрудникам: сервер их и так пускал, пряталась только вкладка.
    { value: 'agent', label: <><Icon name="robot" size={14} /> Агент</> },
    // «Чат» на всю карточку — ответ на «сообщения в маленьких окнах»: колонка справа
    // в 360 точек превращала абзац в двадцать строк, а картинку — в марку.
    { value: 'chat', label: <><Icon name="chat" size={14} /> Чат</> },
  ];

  return (
    <div className="drawer-overlay" {...overlayProps(onClose)}>
      {/*
        Карточка и чат стоят рядом постоянно, как в Битриксе: слева задача целиком —
        со всеми полями, статусами и вкладками, справа разговор по ней.
        Чат вкладкой не работает: обсуждать задачу, не видя её условий, значит держать
        их в голове и прыгать туда-обратно. Окно от этого шире обычного — и должно быть.
      */}
      <aside
        className={`drawer drawer-task task-v2${tab === 'chat' ? ' drawer-task-chat' : ''}${dragOver ? ' drawer-drag' : ''}`}
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
        <div className="task-main">
        {gate && (
          <HandoffGateDialog
            block={gate.block}
            busy={moving}
            onCancel={() => setGate(null)}
            onForce={() => moveToColumn(gate.columnId, true)}
          />
        )}

        <div className="tv2-crumbs">
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
          {columnName && <><span className="tv2-dot" aria-hidden>·</span><span>{columnName}</span></>}
          {isDone && <Badge tone="ok"><Icon name="check" size={11} /> завершена</Badge>}
          {task.agent_assigned && <Badge tone="info" title="Исполнитель — ИИ-агент"><Icon name="robot" size={11} /> ИИ-агент</Badge>}
          {task.is_blocked && <Badge tone="danger"><Icon name="alert" size={11} /> BLOCKED</Badge>}
          {/* Закрытие — крупной кнопкой: карточка на пол-экрана, и уходить из неё
              человек должен уверенным движением, а не целясь в мелкий значок. */}
          <Button variant="ghost" size="icon" className="tv2-close" onClick={onClose} title="Закрыть карточку" aria-label="Закрыть карточку">
            <Icon name="close" size={18} />
          </Button>
        </div>

        {/*
          Заголовок правится прямо здесь, как в Битриксе: название — первое, что человек
          читает и первое, что хочет поправить. Поле растёт под текст: длинное название
          иначе уезжает за край одной строкой.
        */}
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

        {/*
          Задача объединена — об этом надо сказать первой строкой: иначе человек
          продолжит работать в закрытой копии, где комментарии никто не читает.
        */}
        {task.merged_into_id && (
          <div className="tv2-callout tv2-callout-info">
            <Icon name="refresh" size={15} />
            <span>Объединена с задачей #{task.merged_into_id} — работа продолжается там.</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigate({ section: 'projects', projectId: String(task.project_id), taskId: String(task.merged_into_id) })}
            >
              Открыть
            </Button>
          </div>
        )}

        {/*
          Действия над задачей целиком. На виду — главное: завершить и проверить ИИ.
          Остальное (объединить, шаблон, BLOCKED, удалить) — в меню «⋯»: восемь кнопок
          в ряд читались как одна серая полоса, и «Удалить» стояло вплотную к «Завершить».
        */}
        <div className="tv2-actions">
          {targets.length > 0 && (
            <div className="tv2-split">
              {doneTarget ? (
                <>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => moveToColumn(doneTarget.id)}
                    loading={moving}
                    title={`Завершить и перенести в «${doneTarget.name}»`}
                  >
                    <Icon name="check" size={15} /> Завершить
                  </Button>
                  <DropdownMenu
                    align="start"
                    trigger={(
                      <Button variant="primary" size="sm" className="tv2-split-more" disabled={moving} aria-label="Завершить в другую колонку">
                        <Icon name="chevron-down" size={14} />
                      </Button>
                    )}
                  >
                    {targets.map((c) => (
                      <MenuItem key={c.id} onSelect={() => void moveToColumn(c.id)} icon={c.highlight ? <Icon name="check" size={14} /> : undefined}>
                        {c.name}
                      </MenuItem>
                    ))}
                  </DropdownMenu>
                </>
              ) : (
                // «Готово» у проекта нет (импортные доски: «Сдано», «На тестировании») —
                // угадывать за человека не будем, колонку он выбирает сам.
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
                    <MenuItem key={c.id} onSelect={() => void moveToColumn(c.id)} icon={c.highlight ? <Icon name="check" size={14} /> : undefined}>
                      {c.name}
                    </MenuItem>
                  ))}
                </DropdownMenu>
              )}
            </div>
          )}
          {/*
            Проверка ИИ: читает постановку, чек-лист, переписку, документы и смотрит
            скриншоты, а отчёт пишет в обсуждение. Это не приёмка — закрывает задачу
            по-прежнему постановщик.
          */}
          <Button
            variant="outline"
            size="sm"
            onClick={runReview}
            loading={reviewing}
            disabled={moving}
            title="ИИ прочитает задачу, посмотрит вложения и напишет в обсуждение, что проверил"
          >
            {!reviewing && <Icon name="sparkles" size={15} />} {reviewing ? 'Проверяю…' : 'Проверить ИИ'}
          </Button>
          <DropdownMenu
            trigger={(
              <Button variant="ghost" size="icon-sm" aria-label="Ещё действия с задачей" title="Ещё действия">
                <Icon name="more" size={16} />
              </Button>
            )}
          >
            {/* BLOCKED — не правка полей, а метка состояния: ставится и снимается одним нажатием. */}
            <MenuItem onSelect={() => void toggleBlocked()} icon={<Icon name="alert" size={15} />}>
              {task.is_blocked ? 'Снять BLOCKED' : 'Отметить BLOCKED'}
            </MenuItem>
            {!task.merged_into_id && (
              <MenuItem onSelect={() => setMerging(true)} icon={<Icon name="refresh" size={15} />} disabled={moving}>
                Объединить с дублем
              </MenuItem>
            )}
            {/* Шаблон — про СПОСОБ работы, поэтому среди действий над задачей целиком. */}
            <MenuItem onSelect={() => setSaveTpl(true)} icon={<Icon name="copy" size={15} />} disabled={moving}>
              Сохранить как шаблон
            </MenuItem>
            <MenuItem
              onSelect={() => { navigator.clipboard?.writeText(`${window.location.origin}/projects/${task.project_id}/task/${task.id}`).then(() => toastSaved('Ссылка скопирована')).catch(() => undefined); }}
              icon={<Icon name="link" size={15} />}
            >
              Скопировать ссылку
            </MenuItem>
            {canDelete && (
              <>
                <MenuSeparator />
                <MenuItem destructive onSelect={() => void removeTask()} icon={<Icon name="trash" size={15} />} disabled={moving}>
                  Удалить задачу
                </MenuItem>
              </>
            )}
          </DropdownMenu>
        </div>

        {/*
          Свойства — сеткой «подпись · значение», как в Linear: статус, приоритет, риск
          и стоимость читаются одним взглядом, а не ищутся по строкам с кнопками.
        */}
        <dl className="tv2-props">
          {columns.length > 0 && (
            <>
              <dt>Статус</dt>
              <dd className="tv2-status">
                {columns.map((c) => (
                  <button
                    key={c.id}
                    className="ui-toggle ui-toggle-sm"
                    data-pressed={c.id === task.column_id ? '' : undefined}
                    aria-pressed={c.id === task.column_id}
                    onClick={() => moveToColumn(c.id)}
                    disabled={moving}
                    title={c.id === task.column_id ? 'Текущая колонка' : `Переместить в «${c.name}»`}
                  >
                    {c.name}
                  </button>
                ))}
              </dd>
            </>
          )}
          <dt>Приоритет</dt>
          <dd>
            <Select ariaLabel="Приоритет" size="sm" value={priority} onValueChange={setPriority} options={PRIORITY_OPTIONS} />
          </dd>
          {(task.risk_level || (MONETIZATION_ENABLED && cost !== null)) && (
            <>
              <dt>Риск</dt>
              <dd>
                {task.risk_level
                  ? <Badge tone={task.risk_level === 'red' ? 'danger' : task.risk_level === 'yellow' ? 'warn' : 'ok'} title="Риск срыва срока"><Icon name="alert" size={11} /> {task.risk_pct ?? '—'}%</Badge>
                  : <span className="ui-cell-dim">нет прогноза</span>}
                {MONETIZATION_ENABLED && cost !== null && <Badge tone="neutral">₽ {cost.toLocaleString('ru-RU')}</Badge>}
              </dd>
            </>
          )}
          {/* Клиент задачи (ТЗ-17, п. 33) — пока раздел «Клиенты» только в сборке dev. */}
          {CLIENTS_ENABLED && (
            <>
              <dt>Клиент</dt>
              <dd><TaskClientField taskId={task.id} clientId={(task as { client_id?: string | null }).client_id ?? null} onChanged={onRefresh} /></dd>
            </>
          )}
          {/* У поля тегов своя подпись — вторая слева была бы повтором. */}
          <dd className="tv2-props-full"><LabelsRow task={task} onRefresh={onRefresh} /></dd>
        </dl>

        {err && <div className="tv2-callout tv2-callout-danger" role="alert"><Icon name="alert" size={15} /> {err}</div>}

        <Tabs className="tv2-tabs" ariaLabel="Разделы задачи" value={tab} onValueChange={setTab} items={tabItems} />

        {tab === 'chat' && (
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
            onCollapse={() => setTab('overview')}
          />
        )}

        {tab === 'agent' && <AgentTab taskId={task.id} assigned={!!task.agent_assigned} onRefresh={onRefresh} />}

        {tab === 'overview' && (
          <>
            {/* Обе кнопки на виду: одна кнопка-переключатель не показывала, в каком
                состоянии таймер сейчас, и «Пауза» читалась как «идёт пауза». */}
            <div className={`tv2-timer${timerActive ? ' is-running' : ''}`}>
              <div className="tv2-timer-state">
                <span className="timer-dot" />
                <span>{timerActive ? 'Идёт работа' : 'Таймер остановлен'}</span>
              </div>
              <div className="tv2-timer-actions">
                <Button
                  size="sm"
                  variant={timerActive ? 'outline' : 'primary'}
                  disabled={timerActive}
                  title={timerActive ? 'Таймер уже идёт' : 'Начать отсчёт времени по задаче'}
                  onClick={() => onToggleTimer(task.id)}
                >
                  <Icon name="play" size={14} /> В работу
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!timerActive}
                  title={timerActive ? 'Остановить отсчёт' : 'Таймер не запущен'}
                  onClick={() => onToggleTimer(task.id)}
                >
                  <Icon name="pause" size={14} /> Пауза
                </Button>
                {/* «Сделал» — про срок, а не про завершение: задача ждёт следующего круга.
                    Поэтому кнопка у таймера, а не рядом с «Завершить». Кому видна — canShift. */}
                {canShift && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={askShift}
                    disabled={!!task.deadline_shift_to}
                    title={task.deadline_shift_to
                      ? 'Перенос уже отправлен постановщику'
                      : 'Отчитаться и перенести срок на следующую среду, 17:00 (подтверждает постановщик)'}
                  >
                    <Icon name="check-circle" size={14} /> Сделал — срок на среду
                  </Button>
                )}
              </div>
            </div>
            {shiftNote && <div className="tv2-note"><Icon name="check" size={13} /> {shiftNote}</div>}
            {tplNote && <div className="tv2-note"><Icon name="check" size={13} /> {tplNote}</div>}

            {/* Просьба перенести срок — по тем же правилам, что приёмка: видно всем, кнопки — тому, кто решает. */}
            {task.deadline_shift_to && (
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

            {/* Работа сдана и ждёт решения: блок стоит первым — это главное, что
                сейчас происходит с задачей, и адресован он конкретному человеку. */}
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

            {meeting && (
              // Обратная ссылка: из задачи видно, на какой встрече её поручили
              <div className="tv2-origin">
                <Icon name="record" size={13} /> Создано по итогам встречи:{' '}
                <button className="link-btn" onClick={() => navigate({ section: 'chat', view: 'meetings' })}>
                  {meeting.title || 'встреча'}
                </button>
              </div>
            )}

            {fromMessage && (
              // Из задачи видно, из какой фразы она выросла: «а это вообще откуда?» —
              // самый частый вопрос на разборе через неделю после постановки.
              <div className="tv2-origin">
                {task.created_by_ai
                  ? <><Icon name="sparkles" size={13} /> Создано QEVO AI по итогам переписки{' '}</>
                  : <><Icon name="chat" size={13} /> Создано из сообщения{' '}</>}
                {fromMessage.author_name ? `(${fromMessage.author_name})` : ''}:{' '}
                <button
                  className="link-btn"
                  onClick={() => {
                    // раздел откроется и сам покажет строку с подсветкой — событием, адреса у сообщения нет
                    navigate({ section: 'chat', chatId: String(fromMessage.chat_id) });
                    window.setTimeout(() => window.dispatchEvent(new CustomEvent('teamcrm:chat-jump', {
                      detail: { chatId: String(fromMessage.chat_id), messageId: String(fromMessage.message_id) },
                    })), 300);
                  }}
                  title={fromMessage.body}
                >
                  «{fromMessage.body.slice(0, 80)}»
                </button>
                {/* Отзыв о задаче, которую завёл агент (ТЗ-12, разд. 59), и отмена его ошибки:
                    окно — сутки, права проверит сервер. */}
                {task.created_by_ai && (
                  <>{' · '}<AiFeedback send={(b) => api.aiTaskFeedback(task.id, b)} /></>
                )}
                {task.created_by_ai
                  && (!task.created_at || Date.now() - new Date(task.created_at).getTime() < 24 * 3600_000) && (
                  <>
                    {' · '}
                    <button className="link-btn" disabled={moving} onClick={() => void undoAi()}>
                      Отменить — агент ошибся
                    </button>
                  </>
                )}
              </div>
            )}

            {/*
              Описание читается, а не редактируется: пока оно было полем ввода, по ссылке
              нельзя было щёлкнуть, а картинку — увидеть. Правка включается кнопкой.
            */}
            <Field
              className="tv2-desc"
              label="Описание"
              action={(
                <Button
                  size="sm"
                  variant={editingDesc && desc !== (task.description ?? '') ? 'primary' : 'ghost'}
                  onClick={() => setEditingDesc((v) => !v)}
                  title={editingDesc ? 'Закончить правку — сохранится общей кнопкой внизу' : 'Изменить описание'}
                >
                  <Icon name={editingDesc ? 'check' : 'edit'} size={14} /> {editingDesc ? 'Готово' : 'Редактировать'}
                </Button>
              )}
            >
              {/* Визуальный редактор: жирный, списки, картинки по Ctrl+V. В базу уходит
                  лёгкая разметка, поэтому письма и ИИ читают описание как раньше. */}
              {editingDesc ? (
                <RichEditor
                  value={desc}
                  onChange={setDesc}
                  onUploadImage={uploadDescImage}
                  busy={descBusy}
                  autoFocus
                  placeholder="Что нужно сделать. Картинку можно вставить из буфера (Ctrl+V)"
                />
              ) : (
                <TaskDescription text={desc} onEmptyClick={() => setEditingDesc(true)} onOpenImage={setDescPreview} />
              )}
              {descPreview && (
                <Lightbox items={[{ url: descPreview.url, name: descPreview.name, mime: descPreview.mime }]} onClose={() => setDescPreview(null)} />
              )}
            </Field>

            <section className="tv2-section">
              <h3 className="tv2-section-title">Люди</h3>
              {/* Направления — для кого работа (задача #1295); сохраняются сразу. */}
              <TaskDirections taskId={String(task.id)} initial={task.directions ?? []} onRefresh={onRefresh} />
              <div className="tv2-grid2">
                <Field label="Исполнитель" action={
                  /* Совет «кому поручить» — по кнопке; поле остаётся за человеком (ТЗ-10). */
                  <SuggestAssignee title={title} description={desc} projectId={String(task.project_id)} onPick={setAssigneeId} />
                }>
                  <Select ariaLabel="Исполнитель" value={String(assigneeId ?? '')} onValueChange={setAssigneeId} options={userOptions('Не назначен')} className="tv2-wide" />
                </Field>
                <Field label={<span title="Кто ставит задачу и принимает результат">Постановщик</span>}>
                  <Select ariaLabel="Постановщик" value={String(managerId ?? '')} onValueChange={setManagerId} options={userOptions('Не задан')} className="tv2-wide" />
                </Field>
              </div>
              {/* Соисполнители и наблюдатели — рядом с исполнителем: тот же вопрос «кто в задаче». */}
              <div className="tv2-grid2">
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
              </div>
            </section>

            <section className="tv2-section">
              <h3 className="tv2-section-title">План</h3>
              <div className="tv2-grid2">
                <Field label="Срок">
                  <DatePicker value={deadline} onChange={setDeadline} withTime warnPast placeholder="срок не задан" />
                </Field>
                <Field label="Оценка, ч">
                  <Input type="number" min="0" step="0.5" value={estimate} placeholder="не задана" onChange={(e) => setEstimate(e.target.value)} />
                </Field>
              </div>
              {warn && (
                <div className="tv2-callout tv2-callout-warn">
                  <Icon name="alert" size={15} />
                  <span>Перегруз: риск {warn.riskPct ?? '—'}%, {warn.projectedHours} ч &gt; {warn.capacityHours} ч/нед.</span>
                  <Button size="sm" variant="outline" onClick={() => saveAll(true)}>Всё равно назначить</Button>
                </div>
              )}
              {/* Переключатель согласования — право постановщика, пока задача жива. */}
              <Checkbox
                className="tv2-check"
                checked={approval}
                disabled={!isManager || !!task.closed_at}
                onCheckedChange={setApproval}
                label="Не завершать без согласования с постановщиком"
              />
              {/* Повтор — рядом с планом: это ответ на вопрос «когда», а не отдельная тема. */}
              <TaskRecurrenceBlock taskId={task.id} onRefresh={onRefresh} />
              {(task.risk_level || task.predicted_finish_at) && (
                <div className="tv2-note">
                  {task.risk_level && <span className={`risk-dot risk-${task.risk_level}`} />}
                  Прогноз: {task.risk_level ? `риск ${task.risk_pct ?? '—'}%` : 'без оценки риска'}
                  {task.predicted_finish_at && ` · закончится ${new Date(task.predicted_finish_at).toLocaleString('ru-RU')}`}
                </div>
              )}
            </section>

            {/*
              Перенос задачи в другой проект. Живая жалоба: «поставил не туда и не могу
              перенести». Пересоздавать задачу значило потерять переписку, вложения
              и учтённое время.
            */}
            <section className="tv2-section">
              <h3 className="tv2-section-title">Проект</h3>
              <Field hint={movedNote || 'Переписка, вложения и время переедут вместе с задачей'}>
                <Select
                  ariaLabel="Проект задачи"
                  value={String(task.project_id)}
                  onValueChange={(v) => { void moveToProject(v); }}
                  options={projectList.map((p) => ({ value: String(p.id), label: p.name }))}
                  className="tv2-wide"
                />
              </Field>
            </section>
          </>
        )}

        {tab === 'files' && <FilesTab taskId={task.id} onRefresh={onRefresh} onCount={setFileCount} />}
        {tab === 'checklist' && (
          <ChecklistTab
            taskId={task.id}
            onRefresh={onRefresh}
            required={task.checklist_required !== false}
            canSetRequired={isManager || user?.role === 'manager'}
          />
        )}

        {/*
          Полоса сохранения — внизу карточки и всегда на виду, на любой вкладке.
          Ответ на вопрос «мои правки применились?» лежит в ОДНОМ месте.
        */}
        <div className={`task-save-bar${dirty ? ' is-dirty' : ''}`}>
          <span className="task-save-note">
            {dirty
              ? 'Есть несохранённые правки — Ctrl+S или «Сохранить»'
              : 'Всё сохранено. Файлы, теги, люди и чек-лист сохраняются сразу'}
          </span>
          <Button variant="primary" onClick={() => saveAll(false)} disabled={!dirty} loading={saving}>
            {saving ? 'Сохраняю…' : dirty ? 'Сохранить' : 'Сохранено'}
          </Button>
        </div>
        </div>

        {/* Правая колонка — чат задачи. Он на виду всегда: обсуждение и есть работа
            по задаче, а не отдельный раздел, в который надо переключаться. */}
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
            onExpand={() => setTab('chat')}
          />
        </div>
      </aside>

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

function ChecklistTab({ taskId, onRefresh, required, canSetRequired }: {
  taskId: string; onRefresh: () => void;
  /** Без выполненного чек-листа задачу не сдать (задача #1386). */
  required: boolean;
  /** Постановщик или руководство — им решать, обязателен ли чек-лист. */
  canSetRequired: boolean;
}) {
  const [items, setItems] = useState<any[]>([]);
  const [text, setText] = useState('');
  const [strict, setStrict] = useState(required);
  useEffect(() => { setStrict(required); }, [required]);
  const toggleStrict = async (on: boolean) => {
    setStrict(on);
    try { await api.setChecklistRequired(taskId, on); onRefresh(); }
    catch { setStrict(!on); }
  };
  const reload = () => api.listChecklist(taskId).then(setItems).catch(() => undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, [taskId]);
  const done = items.filter((i) => i.is_done).length;
  return (
    <>
      {/*
        Правило видно всем прямо над чек-листом (задача #1386): исполнитель заранее
        знает, что без отмеченных пунктов задачу не сдать, а не узнаёт об этом из возврата.
      */}
      {canSetRequired ? (
        <div className="tv2-rule">
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
        </div>
      ) : strict && items.length > 0 && (
        <div className="tv2-callout tv2-callout-info">
          <Icon name="lock" size={14} /> Задачу не сдать, пока не отмечены все пункты: постановщик не принимает без чек-листа.
        </div>
      )}
      {items.length > 0 && (
        <div className="tv2-progress" aria-label={`Выполнено ${done} из ${items.length}`}>
          <span className="tv2-progress-bar"><span style={{ width: `${Math.round((done / items.length) * 100)}%` }} /></span>
          <span className="tv2-progress-text">{done} из {items.length}</span>
        </div>
      )}
      {items.length === 0 && (
        <EmptyState compact icon="check" title="Чек-листа нет"
          hint="Разбейте задачу на шаги — станет видно, сколько уже сделано, и работу проще передать." />
      )}
      <div className="tv2-list">
        {items.map((i) => (
          <div key={i.id} className={`tv2-list-row${i.is_done ? ' is-done' : ''}`}>
            <Checkbox
              checked={!!i.is_done}
              onCheckedChange={async () => { await api.patchChecklist(taskId, i.id, { isDone: !i.is_done }); reload(); onRefresh(); }}
              label={i.text}
            />
            <Button variant="ghost" size="icon-sm" onClick={async () => { await api.deleteChecklist(taskId, i.id); reload(); onRefresh(); }} title="Удалить пункт" aria-label={`Удалить пункт «${i.text}»`}>
              <Icon name="trash" size={14} />
            </Button>
          </div>
        ))}
      </div>
      <form
        className="tv2-add"
        onSubmit={async (e) => { e.preventDefault(); if (!text.trim()) return; await api.addChecklist(taskId, text.trim()); setText(''); reload(); onRefresh(); }}
      >
        <Input placeholder="Новый пункт — Enter, чтобы добавить" value={text} onChange={(e) => setText(e.target.value)} aria-label="Новый пункт чек-листа" />
        <Button type="submit" variant="primary" disabled={!text.trim()}><Icon name="plus" size={15} /> Добавить</Button>
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
    try { await api.agentRun(taskId); flash('Готово — черновик ниже и в обсуждении задачи'); reload(); onRefresh(); }
    catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка запуска агента'); }
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
    const feedback = await promptText({
      title: 'Доработать результат агента',
      description: 'Агент переделает результат с учётом замечаний.',
      minLength: 2,
      confirmLabel: 'Доработать',
    });
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
          «Передать агенту» — назначить ИИ исполнителем и сразу выполнить (текстовые задачи). Задача пойдёт на «На тестировании» вам на проверку.
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
    for (const f of picked) {
      setBusyName(f.name);
      // по одному и по порядку: параллельная отправка рвётся на середине,
      // и понять, какой файл не долетел, потом нельзя
      try { await api.uploadAttachment(taskId, f); } catch { failed.push(f.name); }
    }
    setBusyName('');
    await reload();
    onRefresh();
    if (failed.length) setErr(`Не загрузились: ${failed.join(', ')}. Попробуйте ещё раз.`);
    else setDone(picked.length === 1 ? `Файл «${picked[0].name}» прикреплён` : `Прикреплено файлов: ${picked.length}`);
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
  return (
    <>
      <div
        className="file-drop"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); void upload(e.dataTransfer.files); }}
      >
        <label className="ui-btn ui-btn-outline ui-btn-sm file-pick">
          <Icon name="paperclip" size={15} /> Загрузить файлы
          <input
            className="file-pick-input"
            type="file"
            multiple
            aria-label="Загрузить файлы в задачу"
            onChange={(e) => { void upload(e.target.files); e.target.value = ''; }}
          />
        </label>
        <span className="dim">или перетащите сюда</span>
      </div>
      {busyName && <div className="tv2-note"><span className="ui-spinner" style={{ width: 13, height: 13 }} /> Загружаю «{busyName}»…</div>}
      {done && <div className="file-ok"><Icon name="check" size={13} /> {done}</div>}
      {err && <div className="error-text" style={{ marginTop: 8 }}>{err}</div>}
      {/*
        Картинки и видео показываем сразу, а не строкой с именем файла.

        Запись из чата приезжала в задачу правильно, но выглядела как «Видео-08-09.mp4»,
        и человек считал, что она не приложилась. Смотреть вложение надо там, где оно
        лежит, а не после скачивания.
      */}
      {media.length > 0 && (
        <div className="task-media">
          {media.map((f) => (
            <AuthedMedia
              key={f.id}
              fileId={String(f.file_id)}
              name={f.file_name}
              mime={String(f.content_type ?? '')}
              onOpen={(p) => setPreview(p)}
            />
          ))}
        </div>
      )}
      {files.map((f) => (
        <div key={f.id} className="tv2-file">
          <Icon name="file" size={15} />
          <button className="file-link" onClick={() => open(f)} aria-busy={opening?.id === String(f.file_id)}>{f.file_name}</button>
          {opening?.id === String(f.file_id) && (
            <span className="dim file-opening"><span className="spin-sm" /> {opening.pct < 0 ? 'открываю…' : `${opening.pct}%`}</span>
          )}
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
        </div>
      ))}
      {files.length === 0 && (
        <EmptyState compact icon="paperclip" title="Файлов нет"
          hint="Прикрепите документы, макеты или скриншоты — они останутся в задаче и будут видны всем участникам." />
      )}
      {preview && <Lightbox items={[{ url: preview.url, name: preview.name, mime: preview.mime }]} onClose={closePreview} />}
    </>
  );
}

/**
 * Описание задачи в режиме чтения.
 *
 * Ссылки кликаются, картинки видны, текст выделяется и копируется — всё то, чего
 * нельзя было сделать, пока описание всегда было полем ввода. Разметка та же, что
 * пишет редактор (lib/rich-text); плоский текст старых задач проходит как был.
 */
function TaskDescription({ text, onEmptyClick, onOpenImage }: {
  text: string;
  onEmptyClick: () => void;
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
  return <RichText text={body} className="task-desc" onOpenImage={onOpenImage} />;
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
    <Field label={<span title={hint}>{label}</span>}>
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
      {/* Значение всегда пустое: выбранный сразу уходит в список выше, поле снова «+ добавить». */}
      <Select
        ariaLabel={`Добавить: ${label.toLowerCase()}`}
        className="tv2-wide"
        value=""
        onValueChange={(v) => { if (v) onAdd(v, role); }}
        options={[
          { value: '', label: '+ добавить' },
          ...users.filter((u) => !taken.has(String(u.id))).map((u) => ({ value: String(u.id), label: u.fullName })),
        ]}
      />
    </Field>
  );
}
