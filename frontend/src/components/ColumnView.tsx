import { DragEvent, useMemo, useState } from 'react';
import { Icon } from './Icon';
import { BottomSheet, SheetAction } from './BottomSheet';
import { useIsPhone } from '../hooks/useMediaQuery';
import type { BoardColumn, Task, User } from '../types';
import { MONETIZATION_ENABLED } from '../config';
import { priorityBadge } from '../lib/labels';
import { COL_DND, TASK_DND } from '../lib/board-dnd';
import { Button } from './ui/button';
import { DropdownMenu, MenuItem, MenuSeparator } from './ui/dropdown-menu';
import { cardStatus, dueText, initials, nextStep, splitDone, stageAge, staleDays, daysWord } from '../lib/board-card';
import { PAUSED_STAGES } from '../lib/board-filter';

interface Props {
  column: BoardColumn;
  users?: User[];
  canEdit: boolean;
  canManage?: boolean;
  /** Удаление колонки: у всех, кто ведёт доску. Удерживает подтверждение в интерфейсе. */
  canDelete?: boolean;
  isFirst?: boolean;
  isLast?: boolean;
  activeTimerTask: string | null;
  onRequestAddTask: (columnId: string) => void;
  onMoveTask: (taskId: string, columnId: string, position: number) => void;
  onOpenTask: (task: Task) => void;
  onRenameColumn?: (columnId: string, name: string) => void;
  /** ТЗ-30: тип этапа колонки */
  onSetStage?: (columnId: string, stage: string) => void;
  onMoveColumn?: (columnId: string, direction: 'left' | 'right') => void;
  onDeleteColumn?: (columnId: string, name: string) => void;
  onColumnDrop?: (sourceId: string, targetId: string) => void;
  /**
   * Все колонки доски — для переноса задачи без перетаскивания (ТЗ-9, волна 1).
   * HTML5 drag-and-drop на телефоне не работает вовсе; кнопка «переместить» на
   * карточке даёт тот же перенос одним нажатием и с клавиатуры.
   */
  columns?: { id: string; name: string; count: number }[];
  /** #4799: кто смотрит — «Ждёт вашего решения», «Вы выполняете». */
  me?: string;
  /** Метки, стоящие почти на всех карточках доски, — ничего не различают и не рисуются. */
  hiddenLabels?: Set<string>;
  /** Свёрнута ли колонка — запоминается на человека и проект. */
  collapsed?: boolean;
  onToggleCollapse?: (columnId: string) => void;
  /** Мягкий порог «в работе на человека» (#4798 §14). */
  wipLimit?: number | null;
  /** #4807 §4: «Подробно» — все поля карточки, как раньше; по умолчанию компактно. */
  detail?: boolean;
  /** #4807 §3, §9.3: «+» в шапке — поле сверху колонки, Enter создаёт задачу. */
  onQuickAdd?: (columnId: string, title: string) => Promise<void>;
}

/** Тип этапа колонки (ТЗ-30) — что значит «задача стоит здесь» для сроков. */
const STAGE_OPTIONS: { id: string; label: string }[] = [
  { id: 'work', label: 'Этап: работа' },
  { id: 'testing', label: 'Этап: тестирование' },
  { id: 'review', label: 'Этап: проверка' },
  { id: 'approval', label: 'Этап: согласование' },
  { id: 'waiting_external', label: 'Этап: ждём клиента' },
  { id: 'done', label: 'Этап: готово' },
];

export function ColumnView({
  column,
  users,
  canEdit,
  canManage = false,
  canDelete = false,
  isFirst = false,
  isLast = false,
  activeTimerTask,
  onRequestAddTask,
  onMoveTask,
  onOpenTask,
  onRenameColumn,
  onSetStage,
  onMoveColumn,
  onDeleteColumn,
  onColumnDrop,
  columns,
  me = '',
  hiddenLabels,
  collapsed = false,
  onToggleCollapse,
  wipLimit,
  detail = false,
  onQuickAdd,
}: Props) {
  const [quick, setQuick] = useState<string | null>(null);
  const [quickBusy, setQuickBusy] = useState(false);
  const submitQuick = async () => {
    const title = (quick ?? '').trim();
    if (!title || !onQuickAdd) { setQuick(null); return; }
    setQuickBusy(true);
    try { await onQuickAdd(column.id, title); setQuick(null); /* созданная задача открывается сама (#4849) */ } finally { setQuickBusy(false); }
  };
  const [over, setOver] = useState(false);
  const [colOver, setColOver] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [colName, setColName] = useState(column.name);
  const stageNow = column.stage_type ?? 'work';

  const submitRename = () => {
    const v = colName.trim();
    if (v && v !== column.name) onRenameColumn?.(column.id, v);
    else setColName(column.name);
    setRenaming(false);
  };

  /*
    «Готово» не вываливает всю историю (#4798 §13): на виду — завершённые за две
    недели и всё, что ещё ждёт согласования; остальное — по «Показать более ранние».
    Ничего не удаляется и не архивируется, поиск и фильтры видят всё.
  */
  const [showOlder, setShowOlder] = useState(false);
  const isDoneCol = stageNow === 'done';
  const split = useMemo(() => (isDoneCol ? splitDone(column.tasks) : { recent: column.tasks, older: [] }), [isDoneCol, column.tasks]);
  const shown = isDoneCol && !showOlder ? split.recent : column.tasks;
  // место среди показанных → место среди задач колонки (часть «Готово» свёрнута)
  const realIndex = (i: number) => (shown === column.tasks ? i : i < shown.length ? column.tasks.indexOf(shown[i]) : column.tasks.length);
  // порог «в работе»: больше N задач у одного человека в этой колонке — мягко подсветить
  const overWip = useMemo(() => {
    if (!wipLimit || isDoneCol || PAUSED_STAGES.includes(stageNow)) return [] as string[];
    const by = new Map<string, number>();
    for (const t of column.tasks) if (t.assignee_id && !t.closed_at) by.set(String(t.assignee_id), (by.get(String(t.assignee_id)) ?? 0) + 1);
    return [...by.entries()].filter(([, n]) => n > wipLimit).map(([id, n]) => {
      const t = column.tasks.find((x) => String(x.assignee_id) === id);
      return `${t?.assignee_name ?? users?.find((u) => String(u.id) === id)?.fullName ?? 'Кто-то'} — ${n}`;
    });
  }, [wipLimit, isDoneCol, stageNow, column.tasks, users]);

  const onDropColumn = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    setColOver(false);
    // перетаскивание колонки имеет приоритет над переносом задачи
    const srcCol = e.dataTransfer.getData(COL_DND);
    if (srcCol) {
      if (srcCol !== column.id) onColumnDrop?.(srcCol, column.id);
      return;
    }
    const taskId = e.dataTransfer.getData('text/plain');
    if (taskId) onMoveTask(taskId, column.id, column.tasks.length);
  };

  const isColumnDrag = (e: DragEvent) => e.dataTransfer.types.includes(COL_DND);

  const onDropCard = (e: DragEvent, index: number) => {
    if (e.dataTransfer.types.includes(COL_DND)) return; // дроп колонки — пусть всплывёт к колонке
    e.preventDefault();
    e.stopPropagation();
    setOver(false);
    const taskId = e.dataTransfer.getData('text/plain');
    if (taskId) onMoveTask(taskId, column.id, realIndex(index));
  };

  if (collapsed) {
    // Свёрнутая колонка — узкая полоса с названием и числом; принимает карточки как обычная.
    return (
      <div
        data-col-id={column.id}
        className={`column is-collapsed ${over ? 'column-over' : ''}`}
        role="button"
        tabIndex={0}
        title={`Развернуть «${column.name}»`}
        aria-label={`Колонка «${column.name}», ${column.tasks.length} — развернуть`}
        onClick={() => onToggleCollapse?.(column.id)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggleCollapse?.(column.id); } }}
        onDragOver={(e) => { if (canEdit && !isColumnDrag(e)) { e.preventDefault(); setOver(true); } }}
        onDragLeave={() => setOver(false)}
        onDrop={canEdit ? onDropColumn : undefined}
      >
        <span className="kv2-count">{column.tasks.length}</span>
        <span className="col-vert">{column.name}</span>
      </div>
    );
  }

  return (
    <div
      data-col-id={column.id}
      className={`column ${over ? 'column-over' : ''} ${colOver ? 'column-dnd-over' : ''} ${dragging ? 'column-dragging' : ''}`}
      onDragOver={(e) => {
        if (isColumnDrag(e)) {
          e.preventDefault();
          setColOver(true);
        } else if (canEdit) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => { setOver(false); setColOver(false); }}
      onDrop={canEdit || canManage ? onDropColumn : undefined}
    >
      <div
        className={`column-head ${canManage && !renaming ? 'column-head-drag' : ''}`}
        draggable={canManage && !renaming}
        onDragStart={(e) => {
          if (!canManage || renaming) return;
          e.dataTransfer.setData(COL_DND, column.id);
          e.dataTransfer.effectAllowed = 'move';
          setDragging(true);
        }}
        onDragEnd={() => setDragging(false)}
      >
        {renaming ? (
          <input
            className="ui-input ui-input-sm col-rename"
            autoFocus
            value={colName}
            onChange={(e) => setColName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitRename();
              if (e.key === 'Escape') { setColName(column.name); setRenaming(false); }
            }}
            onBlur={submitRename}
          />
        ) : (
          <span
            className={canManage ? 'col-name' : undefined}
            title={canManage ? 'Переименовать' : undefined}
            onClick={() => canManage && setRenaming(true)}
          >
            {column.name}
          </span>
        )}
        <span className="col-head-right">
          <span className="kv2-count">{column.tasks.length}</span>
          {!!overWip.length && <span className="col-many" title={`Больше ${wipLimit} у человека: ${overWip.join(', ')}. Проверьте, что сейчас важнее.`}>· много</span>}
          {canEdit && (
            <Button variant="ghost" size="icon-sm" className="kv2-col-menu col-add" aria-label={`Новая задача в «${column.name}»`} title="Новая задача в этой колонке (Enter — создать, Esc — отмена)"
              onClick={() => (onQuickAdd ? setQuick((v) => (v === null ? '' : null)) : onRequestAddTask(column.id))}>
              <Icon name="plus" size={14} />
            </Button>
          )}
          {/* свернуть — всем, кто смотрит доску: это вид, а не управление колонкой */}
          {!canManage && onToggleCollapse && (
            <Button variant="ghost" size="icon-sm" className="kv2-col-menu" onClick={() => onToggleCollapse(column.id)} aria-label={`Свернуть «${column.name}»`} title="Свернуть колонку">
              <Icon name="minimize" size={14} />
            </Button>
          )}
          {/*
            Действия с колонкой — одним меню «⋯». Три мелкие кнопки в шапке каждой
            колонки рябили по всей доске, а «удалить» стояло в пикселе от «вправо».
          */}
          {canManage && !renaming && (
            <DropdownMenu
              trigger={(
                <Button variant="ghost" size="icon-sm" className="kv2-col-menu" aria-label={`Действия с колонкой «${column.name}»`} title="Действия с колонкой">
                  <Icon name="more" size={15} />
                </Button>
              )}
            >
              <MenuItem onSelect={() => setRenaming(true)} icon={<Icon name="edit" size={15} />}>Переименовать</MenuItem>
              {/* ТЗ-30: тип этапа — от него зависит, чья просрочка, пока задача в этой колонке */}
              {onSetStage && (
                <>
                  <MenuSeparator />
                  {STAGE_OPTIONS.map((o) => (
                    <MenuItem key={o.id} onSelect={() => onSetStage(column.id, o.id)}
                      icon={<Icon name={stageNow === o.id ? 'check' : 'target'} size={15} />}>
                      {o.label}
                    </MenuItem>
                  ))}
                  <MenuItem onSelect={() => onSetStage(column.id, 'auto')} icon={<Icon name={column.stage_type_manual ? 'refresh' : 'check'} size={15} />}>
                    Тип по названию
                  </MenuItem>
                </>
              )}
              {onToggleCollapse && (
                <MenuItem onSelect={() => onToggleCollapse(column.id)} icon={<Icon name="minimize" size={15} />}>Свернуть колонку</MenuItem>
              )}
              <MenuItem onSelect={() => onMoveColumn?.(column.id, 'left')} disabled={isFirst} icon={<Icon name="arrow-left" size={15} />}>Сдвинуть влево</MenuItem>
              <MenuItem onSelect={() => onMoveColumn?.(column.id, 'right')} disabled={isLast} icon={<Icon name="arrow-right" size={15} />}>Сдвинуть вправо</MenuItem>
              {canDelete && (
                <>
                  <MenuSeparator />
                  <MenuItem destructive onSelect={() => onDeleteColumn?.(column.id, column.name)} icon={<Icon name="trash" size={15} />}>Удалить колонку</MenuItem>
                </>
              )}
            </DropdownMenu>
          )}
        </span>
      </div>

      {detail && !!overWip.length && (
        <div className="col-wip is-over" title={`Желательно держать в работе не больше ${wipLimit} задач на человека. Количество задач — не оценка занятости: задачи бывают разной сложности.`}>
          Больше {wipLimit} у человека: {overWip.join(', ')}. Проверьте, что сейчас важнее.
        </div>
      )}
      <div className="column-tasks">
        {quick !== null && (
          <div className="col-quick">
            <input
              className="ui-input ui-input-sm"
              autoFocus
              value={quick}
              disabled={quickBusy}
              placeholder="Название задачи — Enter"
              aria-label={`Новая задача в «${column.name}»`}
              onChange={(e) => setQuick(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); void submitQuick(); }
                if (e.key === 'Escape') setQuick(null);
              }}
              onBlur={() => { if (!(quick ?? '').trim()) setQuick(null); }}
            />
            <button className="bb-link" onMouseDown={(e) => e.preventDefault()} onClick={() => { setQuick(null); onRequestAddTask(column.id); }}>Подробнее…</button>
          </div>
        )}
        {shown.map((t, i) => (
          <TaskCard
            key={t.id}
            task={t}
            me={me}
            stage={stageNow}
            columnName={column.name}
            hiddenLabels={hiddenLabels}
            assigneeName={t.assignee_name ?? users?.find((u) => u.id === t.assignee_id)?.fullName ?? null}
            managerName={t.manager_name ?? users?.find((u) => u.id === t.created_by)?.fullName ?? null}
            canEdit={canEdit}
            timerActive={activeTimerTask === t.id}
            onOpen={() => onOpenTask(t)}
            onDropBefore={(e) => onDropCard(e, i)}
            paused={PAUSED_STAGES.includes(stageNow) || t.approval_state === 'pending'}
            moveTargets={columns?.filter((c) => c.id !== column.id)}
            onMoveTo={(columnId) => onMoveTask(t.id, columnId, columns?.find((c) => c.id === columnId)?.count ?? 0)}
            detail={detail}
          />
        ))}
        {isDoneCol && split.older.length > 0 && (
          <Button variant="ghost" size="sm" className="col-older" onClick={() => setShowOlder((v) => !v)}>
            {showOlder ? 'Скрыть более ранние' : `Показать более ранние (${split.older.length})`}
          </Button>
        )}
      </div>

      {canEdit && detail && (
        <Button variant="ghost" size="sm" className="add-task-btn" onClick={() => onRequestAddTask(column.id)}>
          <Icon name="plus" size={15} /> Задача
        </Button>
      )}
    </div>
  );
}

function TaskCard({
  task,
  me,
  stage,
  columnName,
  hiddenLabels,
  assigneeName,
  managerName,
  canEdit,
  timerActive,
  onOpen,
  onDropBefore,
  paused = false,
  moveTargets,
  onMoveTo,
  detail = false,
}: {
  detail?: boolean;
  task: Task;
  me: string;
  stage: string;
  columnName: string;
  hiddenLabels?: Set<string>;
  assigneeName: string | null;
  /** Постановщик — тот, с кого спросят результат. На доске он не менее важен исполнителя. */
  managerName: string | null;
  canEdit: boolean;
  timerActive: boolean;
  onOpen: () => void;
  onDropBefore: (e: DragEvent) => void;
  /** ТЗ-30: задача на проверке — срок прошёл не по вине исполнителя */
  paused?: boolean;
  /** Куда можно перенести без перетаскивания: остальные колонки доски. */
  moveTargets?: { id: string; name: string; count: number }[];
  onMoveTo?: (columnId: string) => void;
}) {
  const cost = task.cost_current !== undefined ? Number(task.cost_current) : null;
  const prio = priorityBadge(task.priority);
  const due = dueText(task.deadline_at, !!task.closed_at, paused);
  /*
    «Переместить» — кнопка на карточке.

    Перетаскивание остаётся для мыши; на телефоне и с клавиатуры до колонки иначе не
    добраться. Список колонок открывается по нажатию и закрывается щелчком мимо.
  */
  const [moveOpen, setMoveOpen] = useState(false);
  const phone = useIsPhone();
  // #4798 §3: чей сейчас ход — из фактического состояния задачи, а не догадки
  const step = nextStep(task, stage, me);
  const age = stageAge(task, stage, columnName);
  const stale = staleDays(task);
  const labels = (task.labels ?? []).filter((l) => !hiddenLabels?.has(String(l.id)));
  /*
    #4807 §4: компактно — 3 строки (№ и приоритет · заголовок до 2 строк · аватар,
    срок или ОДИН статус, счётчики). Что убрали с карточки — в подсказке при наведении.
  */
  const status = detail ? null : cardStatus(step, due);
  const tip = detail ? undefined : [
    task.title,
    `Исполнитель: ${assigneeName ?? 'не назначен'}${managerName ? ` · от ${managerName}` : ''}`,
    `Срок: ${due?.text ?? 'без срока'}${age ? ` · ${age.toLowerCase()}` : ''}`,
    step && step.tone !== 'work' ? step.text : '',
    task.audio_proof_sec ? `Фрагмент созвона ${task.audio_proof_sec} сек` : '',
    task.checklistTotal ? `Чек-лист ${task.checklistDone}/${task.checklistTotal}` : '',
    task.subtasksTotal ? `Подзадачи ${task.subtasksDone}/${task.subtasksTotal}` : '',
    task.parent_task_id ? `Подзадача к #${task.parent_task_id}` : '',
    stale > 0 ? `Нет обновления ${daysWord(stale)}` : '',
    task.agent_assigned ? 'Исполнитель — ИИ-агент' : '',
    task.merged_into_id ? `Объединена с #${task.merged_into_id}` : '',
  ].filter(Boolean).join('\n');
  return (
    <div
      className={`task-card ${timerActive ? 'task-tracking' : ''}${task.unread ? ' task-card-new' : ''}${detail ? '' : ' kc-compact'}${!detail && stale >= 7 ? ' is-stale' : ''}`}
      title={tip}
      style={!detail && labels[0] ? { ['--kc-tag' as string]: labels[0].color } : undefined}
      data-task-id={task.id}
      draggable={canEdit}
      onClick={onOpen}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', task.id);
        // Своя пометка: по ней лента колонок понимает, что едет за нашей карточкой,
        // а не за куском текста, выделенным на странице.
        e.dataTransfer.setData(TASK_DND, task.id);
      }}
      onDrop={canEdit ? onDropBefore : undefined}
      onDragOver={(e) => canEdit && e.preventDefault()}
    >
      {canEdit && !!moveTargets?.length && (
        <div className="task-card-move" onClick={(e) => e.stopPropagation()}>
          {phone ? (
            <button
              className="task-card-move-btn"
              title="Переместить в другую колонку"
              aria-label="Переместить в другую колонку"
              aria-haspopup="menu"
              aria-expanded={moveOpen}
              onClick={() => setMoveOpen((v) => !v)}
            >
              <Icon name="arrow-right" size={13} />
            </button>
          ) : (
            <DropdownMenu
              trigger={(
                <button className="task-card-move-btn" title="Переместить в другую колонку" aria-label="Переместить в другую колонку">
                  <Icon name="arrow-right" size={13} />
                </button>
              )}
            >
              {moveTargets.map((c) => (
                <MenuItem key={c.id} onSelect={() => onMoveTo?.(c.id)} icon={<Icon name="arrow-right" size={15} />}>{c.name}</MenuItem>
              ))}
            </DropdownMenu>
          )}
          {/* #4807 §4: при наведении — «Переместить» и «⋯» */}
          {!phone && !detail && (
            <DropdownMenu
              trigger={(
                <button className="task-card-move-btn" title="Ещё" aria-label="Действия с задачей">
                  <Icon name="more" size={13} />
                </button>
              )}
            >
              <MenuItem onSelect={onOpen} icon={<Icon name="maximize" size={15} />}>Открыть задачу</MenuItem>
              <MenuItem
                onSelect={() => { void navigator.clipboard?.writeText(`${window.location.origin}/projects/${task.project_id}/task/${task.id}`).catch(() => undefined); }}
                icon={<Icon name="link" size={15} />}
              >
                Скопировать ссылку
              </MenuItem>
            </DropdownMenu>
          )}
          {/* На телефоне — нижний лист с крупными строками; на компьютере — выпадашка у кнопки. */}
          {moveOpen && phone && (
            <BottomSheet title={`Переместить: ${task.title}`} onClose={() => setMoveOpen(false)}>
              {moveTargets.map((c) => (
                <SheetAction key={c.id} icon={<Icon name="arrow-right" size={18} />} label={c.name} onClick={() => { setMoveOpen(false); onMoveTo?.(c.id); }} />
              ))}
            </BottomSheet>
          )}
        </div>
      )}
      {!detail ? (<>
        <div className="kc-line1">
          <span>№{task.id}</span>
          {prio && (task.priority === 'high' || task.priority === 'urgent') && <span className={`kc-prio p-${task.priority}`}>{prio.label}</span>}
          {task.risk_level && !paused && <span className={`risk-dot risk-${task.risk_level}`} title={`Риск срока: ${task.risk_level}`} />}
          {/* #4855: было синей точкой 7 px — её не замечали; теперь крупный яркий синий кружок с числом */}
          {!!task.unread && (
            <span className="kc-unread" title={`Новое для вас: ${task.unread} — с вашего последнего просмотра (не просрочка)`} aria-label={`Новое для вас: ${task.unread}`}>
              {task.unread > 99 ? '99+' : task.unread}
            </span>
          )}
        </div>
        <div className="task-title kc-title">{task.title}</div>
        <div className="kc-line3">
          <span className="kc-ava" style={{ background: avatarColor(task.assignee_id) }} aria-label={assigneeName ? `Исполнитель: ${assigneeName}` : 'Исполнитель не назначен'}>{assigneeName ? initials(assigneeName) : '—'}</span>
          {status
            ? <span className={`kc-st t-${status.tone}`}>{status.text}</span>
            : <span className={`kc-due d-${due?.tone ?? 'none'}`}>{due?.text ?? '—'}</span>}
          <span className="kc-icons">
            {!!task.commentsCount && <span><Icon name="chat" size={12} />{task.commentsCount}</span>}
            {!!task.attachmentsCount && <span><Icon name="paperclip" size={12} />{task.attachmentsCount}</span>}
            {!!task.checklistTotal && <span className={task.checklistDone === task.checklistTotal ? 'is-done' : undefined}><Icon name="check" size={12} />{task.checklistDone}/{task.checklistTotal}</span>}
            {/* #4846: подзадачи «завершено/всего»; у самой подзадачи — значок, что она часть другой */}
            {!!task.subtasksTotal && <span className={task.subtasksDone === task.subtasksTotal ? 'is-done' : undefined} title={`Подзадачи: завершено ${task.subtasksDone} из ${task.subtasksTotal}`} aria-label={`Подзадачи: завершено ${task.subtasksDone} из ${task.subtasksTotal}`}><Icon name="list" size={12} />{task.subtasksDone}/{task.subtasksTotal}</span>}
            {!!task.parent_task_id && <span title={`Подзадача к #${task.parent_task_id}`} aria-label={`Подзадача к #${task.parent_task_id}`}><Icon name="arrow-up" size={12} />#{task.parent_task_id}</span>}
          </span>
        </div>
      </>) : (<>
      {labels.length > 0 && (
        <div className="card-labels">
          {labels.map((l) => <span key={l.id} className="card-label" style={{ background: l.color }} title={`Тег: ${l.name}`} />)}
        </div>
      )}
      {/* #4799, макет 01: первой строкой — номер, приоритет, файлы, сколько на этапе */}
      <div className="kc-top">
        <span title="Номер задачи">№{task.id}</span>
        {prio && <span title="Приоритет">{prio.label} приоритет</span>}
        {!!task.attachmentsCount && <span title="Вложения">{task.attachmentsCount} {fileWord(task.attachmentsCount)}</span>}
        {!!task.audio_proof_sec && <span title="Есть фрагмент созвона с поручением">созвон {task.audio_proof_sec} сек</span>}
        {task.recurrence_id && <span title="Регулярная задача — повторяется по расписанию">повтор</span>}
        {stale > 0
          ? <span className="kc-stale" title="Ни правок, ни сообщений, ни переносов. Это не значит, что работа не идёт — уточните состояние в карточке">нет обновления {daysWord(stale)}</span>
          : age && <span title="Сколько рабочих дней задача на нынешнем этапе">{age.toLowerCase()}</span>}
      </div>
      <div className="task-title">
        {task.risk_level && !paused && <span className={`risk-dot risk-${task.risk_level}`} title={`Риск срока: ${task.risk_level}`} />}
        {task.title}
        {!!task.unread && (
          <span className="task-unread" title={`Новое для вас: ${task.unread} изменений с вашего последнего просмотра (не просрочка)`}>
            {task.unread > 99 ? '99+' : task.unread}
          </span>
        )}
      </div>
      <div className="kc-people">
        <span className="kc-who" title={assigneeName ? `Исполнитель: ${assigneeName}` : 'Исполнитель не назначен'}>
          <span className={`kc-dot${assigneeName ? '' : ' is-empty'}`} aria-hidden="true" />
          {assigneeName ?? 'не назначен'}
        </span>
        {managerName && <span className="kc-from" title={`Постановщик: ${managerName}`}>от {managerName}</span>}
      </div>
      {(step && step.tone !== 'work') || task.agent_assigned || task.merged_into_id ? (
        <div className="kc-chips">
          {step && step.tone !== 'work' && (
            <span className={`kc-chip t-${step.tone}`} title={step.title}>
              {step.text}{task.approval_state === 'pending' ? ' · На согласовании' : ''}
            </span>
          )}
          {task.agent_assigned && <span className="kc-chip" title="Исполнитель — ИИ-агент">ИИ-агент</span>}
          {task.merged_into_id && <span className="kc-chip" title={`Объединена с задачей #${task.merged_into_id}`}>объединена с #{task.merged_into_id}</span>}
        </div>
      ) : null}
      <div className="kc-foot">
        {due ? <span className={`kc-due d-${due.tone}`} title={task.deadline_at ? `Срок: ${new Date(task.deadline_at).toLocaleString('ru-RU')}` : undefined}>{due.text}</span> : <span className="kc-due d-none">без срока</span>}
        <span className="kc-counts">
          {!!task.checklistTotal && <span className={task.checklistDone === task.checklistTotal ? 'is-done' : undefined} title="Чек-лист">Чек-лист {task.checklistDone}/{task.checklistTotal}</span>}
          {!!task.subtasksTotal && <span className={task.subtasksDone === task.subtasksTotal ? 'is-done' : undefined} title="Подзадачи: завершено / всего">Подзадачи {task.subtasksDone}/{task.subtasksTotal}</span>}
          {!!task.parent_task_id && <span title="Эта задача — часть другой">Подзадача к #{task.parent_task_id}</span>}
          {!!task.commentsCount && <span title="Сообщений в обсуждении">Комментарии {task.commentsCount}</span>}
          {MONETIZATION_ENABLED && cost !== null && <span title="Себестоимость в реальном времени">₽ {cost.toLocaleString('ru-RU', { maximumFractionDigits: 0 })}</span>}
        </span>
      </div>
      </>)}
    </div>
  );
}

/** Цвет аватара по человеку — один и тот же на всей доске. */
function avatarColor(id: string | null | undefined): string {
  if (!id) return 'var(--border-2)';
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 45%)`;
}

/** «1 файл», «2 файла», «5 файлов». */
function fileWord(n: number): string {
  const m10 = n % 10; const m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? 'файл' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'файла' : 'файлов';
}
