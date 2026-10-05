import { DragEvent, useState } from 'react';
import { Icon } from './Icon';
import { BottomSheet, SheetAction } from './BottomSheet';
import { useIsPhone } from '../hooks/useMediaQuery';
import type { BoardColumn, Task, User } from '../types';
import { MONETIZATION_ENABLED } from '../config';
import { deadlineBadge, priorityBadge } from '../lib/labels';
import { COL_DND, TASK_DND } from '../lib/board-dnd';
import { Avatar } from './ui/avatar';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { DropdownMenu, MenuItem, MenuSeparator } from './ui/dropdown-menu';

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
  onMoveColumn?: (columnId: string, direction: 'left' | 'right') => void;
  onDeleteColumn?: (columnId: string, name: string) => void;
  onColumnDrop?: (sourceId: string, targetId: string) => void;
  /**
   * Все колонки доски — для переноса задачи без перетаскивания (ТЗ-9, волна 1).
   * HTML5 drag-and-drop на телефоне не работает вовсе; кнопка «переместить» на
   * карточке даёт тот же перенос одним нажатием и с клавиатуры.
   */
  columns?: { id: string; name: string; count: number }[];
}

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
  onMoveColumn,
  onDeleteColumn,
  onColumnDrop,
  columns,
}: Props) {
  const [over, setOver] = useState(false);
  const [colOver, setColOver] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [colName, setColName] = useState(column.name);

  const submitRename = () => {
    const v = colName.trim();
    if (v && v !== column.name) onRenameColumn?.(column.id, v);
    else setColName(column.name);
    setRenaming(false);
  };

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
    if (taskId) onMoveTask(taskId, column.id, index);
  };

  return (
    <div
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

      <div className="column-tasks">
        {column.tasks.map((t, i) => (
          <TaskCard
            key={t.id}
            task={t}
            assigneeName={t.assignee_name ?? users?.find((u) => u.id === t.assignee_id)?.fullName ?? null}
            managerName={t.manager_name ?? users?.find((u) => u.id === t.created_by)?.fullName ?? null}
            canEdit={canEdit}
            timerActive={activeTimerTask === t.id}
            onOpen={() => onOpenTask(t)}
            onDropBefore={(e) => onDropCard(e, i)}
            moveTargets={columns?.filter((c) => c.id !== column.id)}
            onMoveTo={(columnId) => onMoveTask(t.id, columnId, columns?.find((c) => c.id === columnId)?.count ?? 0)}
          />
        ))}
      </div>

      {canEdit && (
        <Button variant="ghost" size="sm" className="add-task-btn" onClick={() => onRequestAddTask(column.id)}>
          <Icon name="plus" size={15} /> Задача
        </Button>
      )}
    </div>
  );
}

function TaskCard({
  task,
  assigneeName,
  managerName,
  canEdit,
  timerActive,
  onOpen,
  onDropBefore,
  moveTargets,
  onMoveTo,
}: {
  task: Task;
  assigneeName: string | null;
  /** Постановщик — тот, с кого спросят результат. На доске он не менее важен исполнителя. */
  managerName: string | null;
  canEdit: boolean;
  timerActive: boolean;
  onOpen: () => void;
  onDropBefore: (e: DragEvent) => void;
  /** Куда можно перенести без перетаскивания: остальные колонки доски. */
  moveTargets?: { id: string; name: string; count: number }[];
  onMoveTo?: (columnId: string) => void;
}) {
  const cost = task.cost_current !== undefined ? Number(task.cost_current) : null;
  const prio = priorityBadge(task.priority);
  const due = deadlineBadge(task.deadline_at, !!task.closed_at);
  /*
    «Переместить» — кнопка на карточке.

    Перетаскивание остаётся для мыши; на телефоне и с клавиатуры до колонки иначе не
    добраться. Список колонок открывается по нажатию и закрывается щелчком мимо.
  */
  const [moveOpen, setMoveOpen] = useState(false);
  const phone = useIsPhone();
  return (
    <div
      className={`task-card ${timerActive ? 'task-tracking' : ''}${task.unread ? ' task-card-new' : ''}`}
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
      {task.labels && task.labels.length > 0 && (
        <div className="card-labels">
          {task.labels.map((l) => <span key={l.id} className="card-label" style={{ background: l.color }} title={l.name} />)}
        </div>
      )}
      <div className="task-title">
        {task.risk_level && <span className={`risk-dot risk-${task.risk_level}`} title={`Риск срока: ${task.risk_level}`} />}
        {task.title}
        {/* Сколько по задаче нового ЛИЧНО ДЛЯ МЕНЯ: чужие изменения после того, как
            я последний раз открывал карточку. Стоит у заголовка, а не среди значков
            внизу: это не свойство задачи, а повод её открыть. */}
        {!!task.unread && (
          <span className="task-unread" title={`${task.unread} новых изменений с вашего последнего просмотра`}>
            {task.unread > 99 ? '99+' : task.unread}
          </span>
        )}
      </div>
      <div className="task-meta">
        {/* Номер — первым: по нему задачу называют в переписке, в отчёте боту и
            в чужой ссылке. Раньше он был только внутри карточки, и чтобы ответить
            «сделал 1264», её приходилось открывать. */}
        <span className="task-card-num" title="Номер задачи">#{task.id}</span>
        {assigneeName && (
          <span className="assignee-chip" title={`Исполнитель: ${assigneeName}`}>
            <Avatar name={assigneeName} size={18} />
            {assigneeName}
          </span>
        )}
        {/* Постановщик — второй чип, приглушённый: главный вопрос карточки «кто делает»,
            а «кто поручил» нужен, когда с работой что-то не так. Показываем всегда,
            когда он известен, даже если человек поставил задачу себе: два пустых
            места в карточке хуже одного повтора имени. */}
        {managerName && (
          <span className="manager-chip" title={`Постановщик: ${managerName}`}>
            <Icon name="send" size={11} /> от {managerName}
          </span>
        )}
        {task.agent_assigned && <Badge tone="info" title="Исполнитель — ИИ-агент"><Icon name="robot" size={11} /> ИИ-агент</Badge>}
        {/* Сдано и ждёт постановщика: по доске должно быть видно, что работа
            сделана, но задача ещё не закрыта — иначе «Готово» врёт. */}
        {task.approval_state === 'pending' && (
          <Badge tone="warn" title="Работа сдана, ждёт решения постановщика">На согласовании</Badge>
        )}
        {/* Объединённая задача остаётся в списках, и без пометки её открывают как живую */}
        {task.merged_into_id && (
          <Badge tone="info" title={`Объединена с задачей #${task.merged_into_id}`}>
            <Icon name="refresh" size={11} /> объединена
          </Badge>
        )}
        {task.is_blocked && <Badge tone="danger"><Icon name="alert" size={11} /> BLOCKED</Badge>}
        {prio && (
          <Badge tone={prio.tone} title="Приоритет">
            <Icon name={prio.tone === 'danger' ? 'zap' : prio.tone === 'warn' ? 'arrow-up' : 'arrow-down'} size={11} />{prio.label}
          </Badge>
        )}
        {due && <Badge tone={due.tone} title={due.title}><Icon name="clock" size={11} />{due.label}</Badge>}
        {/* Повтор — первым: он объясняет, ПОЧЕМУ задача снова на доске. Без значка
            очередная копия выглядит дублем, и её удаляют «как лишнюю». */}
        {task.recurrence_id && (
          <Badge tone="neutral" title="Регулярная задача — повторяется по расписанию">
            <Icon name="refresh" size={11} /> повтор
          </Badge>
        )}
        {!!task.commentsCount && <span className="kv2-stat" title="Комментарии"><Icon name="chat" size={13} /> {task.commentsCount}</span>}
        {!!task.attachmentsCount && <span className="kv2-stat" title="Вложения"><Icon name="paperclip" size={13} /> {task.attachmentsCount}</span>}
        {!!task.checklistTotal && (
          <span className={`kv2-stat${task.checklistDone === task.checklistTotal ? ' is-done' : ''}`} title="Чек-лист">
            <Icon name="check-circle" size={13} /> {task.checklistDone}/{task.checklistTotal}
          </span>
        )}
        {MONETIZATION_ENABLED && cost !== null && (
          <Badge tone="neutral" title="Себестоимость в реальном времени">
            ₽ {cost.toLocaleString('ru-RU', { maximumFractionDigits: 0 })}
          </Badge>
        )}
      </div>
    </div>
  );
}
