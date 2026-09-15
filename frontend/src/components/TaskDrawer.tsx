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
import { TaskChat } from './TaskChat';
import { TaskRecurrenceBlock } from './TaskRecurrence';
import { TaskMergeModal } from './TaskMergeModal';
import { AuthedMedia } from './AuthedMedia';
import { RichText } from './RichText';
import { RichEditor } from './RichEditor';
import { MONETIZATION_ENABLED } from '../config';
import { labelTextColor } from '../lib/labels';
import { overlayProps } from '../lib/overlay';
import { showToast, toastSaved } from '../lib/notifications';

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
    const deadlineAt = deadline ? new Date(deadline).toISOString() : undefined;
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
      if (Object.keys(patch).length) await api.updateTask(task.id, patch);

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

  // BLOCKED — не правка полей, а метка состояния: её ставят и снимают одним нажатием.
  const toggleBlocked = async () => { await api.updateTask(task.id, { isBlocked: !task.is_blocked }); onRefresh(); };
  // сменить статус = переместить в колонку доски (наверх колонки)
  const [moving, setMoving] = useState(false);
  /** Открыто окно объединения: поиск дубля и предпросмотр. */
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
  /** Где задача стоит сейчас — подпись в шапке чата: «о чём разговор и на каком этапе». */
  const columnName = columns.find((c) => String(c.id) === String(task.column_id))?.name ?? null;

  return (
    <div className="drawer-overlay" {...overlayProps(onClose)}>
      {/*
        Карточка и чат стоят рядом постоянно, как в Битриксе: слева задача целиком —
        со всеми полями, статусами и вкладками, справа разговор по ней.
        Чат вкладкой не работает: обсуждать задачу, не видя её условий, значит держать
        их в голове и прыгать туда-обратно. Окно от этого шире обычного — и должно быть.
      */}
      <aside
        className={`drawer drawer-task${tab === 'chat' ? ' drawer-task-chat' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
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
          {/*
            Заголовок правится прямо здесь.

            Так сделано в Битриксе, и это правильно: название — первое, что человек
            читает и первое, что хочет поправить. Отдельное поле «Название» ниже по
            карточке дублировало его и заставляло искать, где же настоящее.

            Поле растёт под текст: длинное название иначе уезжает за край одной
            строкой, и прочитать его можно только стрелками.
          */}
          <h3 className="drawer-title">
            <textarea
              className="drawer-title-input"
              value={title}
              rows={1}
              placeholder="Название задачи"
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
          {/* Закрытие — крупной кнопкой: карточка на пол-экрана, и уходить из неё
              человек должен уверенным движением, а не целясь в мелкий значок. */}
          <button className="drawer-close" onClick={onClose} title="Закрыть карточку" aria-label="Закрыть карточку">
            <Icon name="close" size={20} />
          </button>
        </div>

        {/* Завершение — отдельной строкой под заголовком. Сбоку от названия кнопка
            жалась к «закрыть» и терялась тем сильнее, чем длиннее название задачи. */}
        {/*
          Задача объединена — об этом надо сказать первой строкой.

          Иначе человек продолжит работать в закрытой копии: комментарии он оставит
          там, где их никто не читает. Ссылка ведёт в основную задачу.
        */}
        {task.merged_into_id && (
          <div className="merge-banner">
            <Icon name="refresh" size={14} />
            <span>Объединена с задачей #{task.merged_into_id} — работа продолжается там.</span>
            <button
              className="btn btn-sm"
              onClick={() => navigate({ section: 'projects', projectId: String(task.project_id), taskId: String(task.merged_into_id) })}
            >
              Открыть
            </button>
          </div>
        )}

        {(isDone || targets.length > 0 || canDelete) && (
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
            {/*
              Проверка ИИ.

              Читает постановку, чек-лист, переписку, документы и СМОТРИТ скриншоты,
              после чего пишет отчёт в переписку задачи. Это не приёмка: задачу
              по-прежнему закрывает постановщик — ИИ только собирает доводы.
            */}
            <button
              className="btn btn-ghost btn-sm"
              onClick={runReview}
              disabled={reviewing || moving}
              title="ИИ прочитает задачу, посмотрит вложения и напишет в обсуждение, что проверил"
            >
              <Icon name="sparkles" size={14} /> {reviewing ? 'Проверяю…' : 'Проверить ИИ'}
            </button>
            {/* Объединение — рядом с завершением: это тоже способ закрыть задачу,
                только не выбрасывая её содержимое. */}
            {!task.merged_into_id && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setMerging(true)}
                disabled={moving}
                title="Найти дубль этой задачи и объединить их в одну"
              >
                <Icon name="refresh" size={14} /> Объединить
              </button>
            )}
            {canDelete && (
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
          <select className="input prio-select" value={priority} onChange={(e) => setPriority(e.target.value)}>
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
          <button className={`tab ${tab === 'files' ? 'active' : ''}`} onClick={() => setTab('files')}>
            Файлы{fileCount > 0 && <span className="tab-count">{fileCount}</span>}
          </button>
          <button className={`tab ${tab === 'checklist' ? 'active' : ''}`} onClick={() => setTab('checklist')}>Чеклист</button>
          {/* ИИ-агент доступен всем сотрудникам: сервер их и так пускал, пряталась
              только вкладка — человек видел у руководителя возможность, которой у него
              «нет», хотя на деле она была. */}
          <button className={`tab ${tab === 'agent' ? 'active' : ''}`} onClick={() => setTab('agent')}><Icon name="robot" size={14} /> Агент</button>
          {/*
            Вкладка «Чат» — ответ на «сообщения в маленьких окнах».

            Колонка справа шириной в 360 точек превращает абзац из пяти строк в
            двадцать, а картинку — в марку. Здесь разговор занимает карточку целиком:
            читать длинное сообщение становится так же удобно, как в мессенджере.
            Колонка при этом никуда не делась — из неё в эту вкладку ведёт «развернуть».
          */}
          <button className={`tab ${tab === 'chat' ? 'active' : ''}`} onClick={() => setTab('chat')}>
            <Icon name="chat" size={14} /> Чат
          </button>
        </div>

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

            {fromMessage && (
              // Из задачи видно, из какой фразы она выросла. Через неделю после
              // постановки «а это вообще откуда?» — самый частый вопрос на разборе.
              <div className="dim task-origin">
                <Icon name="chat" size={12} /> Создано из сообщения{' '}
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
              </div>
            )}

            {/* Поля «Название» здесь больше нет: заголовок правится в шапке карточки,
                а два поля об одном и том же расходились и путали. */}
            {/*
              Описание читается, а не редактируется.

              Пока оно было полем ввода, по ссылке в постановке нельзя было щёлкнуть,
              а картинку — увидеть: текст в textarea можно только выделить и скопировать.
              Правка включается кнопкой, как в Битриксе.
            */}
            <div className="field">
              <label>
                Описание
                {/* Пока описание правили — «Готово» горит: человек должен видеть,
                    что от него ждут действия, не разглядывая полосу внизу карточки. */}
                <button
                  className={`btn btn-sm desc-edit-btn${editingDesc && desc !== (task.description ?? '') ? ' btn-primary' : ' btn-ghost'}`}
                  onClick={() => setEditingDesc((v) => !v)}
                  title={editingDesc ? 'Закончить правку — сохранится общей кнопкой внизу' : 'Изменить описание'}
                >
                  <Icon name={editingDesc ? 'check' : 'edit'} size={13} /> {editingDesc ? 'Готово' : 'Редактировать'}
                </button>
              </label>
              {/* Визуальный редактор — как в WordPress: жирный, списки, картинки по Ctrl+V.
                  В базу уходит лёгкая разметка, поэтому письма и ИИ читают описание как раньше. */}
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
                <Lightbox url={descPreview.url} name={descPreview.name} mime={descPreview.mime} onClose={() => setDescPreview(null)} />
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
                  <select className="input" value={managerId} onChange={(e) => setManagerId(e.target.value)}>
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
                  <button className="btn btn-sm overload-confirm" onClick={() => saveAll(true)}>Всё равно назначить</button>
                </div>
              )}
              {/* Переключатель согласования — право постановщика, пока задача жива. */}
              <label className="notify-row" title="Исполнитель сдаёт работу, завершаете её вы">
                <input
                  type="checkbox"
                  checked={approval}
                  disabled={!isManager || !!task.closed_at}
                  onChange={(e) => setApproval(e.target.checked)}
                />
                Не завершать без согласования с постановщиком
              </label>
            </div>
            {/* Повтор — рядом с планом: это ответ на вопрос «когда», а не отдельная тема. */}
            <TaskRecurrenceBlock taskId={task.id} onRefresh={onRefresh} />

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

        {tab === 'files' && <FilesTab taskId={task.id} onRefresh={onRefresh} onCount={setFileCount} />}
        {tab === 'checklist' && <ChecklistTab taskId={task.id} onRefresh={onRefresh} />}

        {/*
          Полоса сохранения — внизу карточки и всегда на виду, на любой вкладке.

          Ответ на вопрос «мои правки применились?» должен лежать в ОДНОМ месте и не
          уезжать за край экрана. Раньше кнопок сохранения было две, обе в середине
          длинной карточки, а половина полей сохранялась молча — и человек, прикрепив
          файл, смотрел на неактивную кнопку и не понимал, случилось ли хоть что-то.
        */}
        <div className={`task-save-bar${dirty ? ' is-dirty' : ''}`}>
          <span className="task-save-note">
            {dirty
              ? 'Есть несохранённые правки — Ctrl+S или «Сохранить»'
              : 'Всё сохранено. Файлы, метки, люди и чек-лист сохраняются сразу'}
          </span>
          <button className="btn btn-primary" onClick={() => saveAll(false)} disabled={!dirty || saving}>
            {saving ? 'Сохраняю…' : dirty ? 'Сохранить' : 'Сохранено'}
          </button>
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

      {merging && (
        <TaskMergeModal
          taskId={String(task.id)}
          taskTitle={task.title}
          onClose={() => setMerging(false)}
          onMerged={(r) => {
            setMerging(false);
            // Уходим в основную задачу: она могла оказаться и в другом проекте,
            // а оставаться в объединённой копии человеку незачем.
            navigate({ section: 'projects', projectId: r.projectId, taskId: r.taskId });
            onRefresh();
          }}
        />
      )}
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
            <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>Совет: удачный промпт сохраните в «Личный кабинет → Профиль → Мои промпты», чтобы переиспользовать.</div>
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
  const open = async (f: any) => {
    setErr('');
    try {
      const blob = await api.authedBlob(`/api/files/${f.file_id}`);
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
    }
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
        <label className="btn btn-sm file-pick">
          <Icon name="paperclip" size={14} /> Загрузить файлы
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
      {busyName && <div className="dim" style={{ marginTop: 8 }}>Загружаю «{busyName}»…</div>}
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
        <div key={f.id} className="team-row team-head">
          <button className="file-link" onClick={() => open(f)}>{f.file_name}</button>
          <button className="btn btn-ghost btn-sm" onClick={async () => { await api.deleteAttachment(taskId, f.id); await reload(); onRefresh(); }} title="Удалить"><Icon name="close" size={13} /></button>
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
