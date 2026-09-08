import { DragEvent, useState } from 'react';
import { Icon } from './Icon';
import type { BoardColumn, Task, User } from '../types';
import { MONETIZATION_ENABLED } from '../config';
import { deadlineBadge, priorityBadge } from '../lib/labels';

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
}

const COL_DND = 'application/x-teamcrm-column';

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
            className="input col-rename"
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
          {canManage && !renaming && (
            <span className="col-actions">
              {/* Стрелки были текстовыми значками «◀ ▶»: в светлой теме они выглядели
                  чужеродными чёрными треугольниками, а выключенные — почти невидимыми.
                  Теперь это обычные иконки набора, как везде. */}
              <button className="col-btn" title="Переместить колонку влево" aria-label="Переместить колонку влево" disabled={isFirst} onClick={() => onMoveColumn?.(column.id, 'left')}>
                <Icon name="chevron-left" size={14} />
              </button>
              <button className="col-btn" title="Переместить колонку вправо" aria-label="Переместить колонку вправо" disabled={isLast} onClick={() => onMoveColumn?.(column.id, 'right')}>
                <Icon name="chevron-right" size={14} />
              </button>
              {canDelete && (
                <button className="col-btn col-del" title="Удалить колонку" aria-label="Удалить колонку" onClick={() => onDeleteColumn?.(column.id, column.name)}>
                  <Icon name="close" size={13} />
                </button>
              )}
            </span>
          )}
          <span className="badge">{column.tasks.length}</span>
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
          />
        ))}
      </div>

      {canEdit && (
        <button className="btn btn-ghost btn-sm add-task-btn" onClick={() => onRequestAddTask(column.id)}>
          + Задача
        </button>
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
}: {
  task: Task;
  assigneeName: string | null;
  /** Постановщик — тот, с кого спросят результат. На доске он не менее важен исполнителя. */
  managerName: string | null;
  canEdit: boolean;
  timerActive: boolean;
  onOpen: () => void;
  onDropBefore: (e: DragEvent) => void;
}) {
  const cost = task.cost_current !== undefined ? Number(task.cost_current) : null;
  const prio = priorityBadge(task.priority);
  const due = deadlineBadge(task.deadline_at, !!task.closed_at);
  return (
    <div
      className={`task-card ${timerActive ? 'task-tracking' : ''}${task.unread ? ' task-card-new' : ''}`}
      draggable={canEdit}
      onClick={onOpen}
      onDragStart={(e) => e.dataTransfer.setData('text/plain', task.id)}
      onDrop={canEdit ? onDropBefore : undefined}
      onDragOver={(e) => canEdit && e.preventDefault()}
    >
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
            <span className="avatar-xs avatar-ph">{assigneeName[0]?.toUpperCase()}</span>
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
        {task.agent_assigned && <span className="badge badge-info" title="Исполнитель — ИИ-агент"><Icon name="robot" size={12} /> ИИ-агент</span>}
        {/* Сдано и ждёт постановщика: по доске должно быть видно, что работа
            сделана, но задача ещё не закрыта — иначе «Готово» врёт. */}
        {task.approval_state === 'pending' && (
          <span className="badge badge-warn" title="Работа сдана, ждёт решения постановщика">На согласовании</span>
        )}
        {task.is_blocked && <span className="badge badge-blocked">BLOCKED</span>}
        {prio && <span className={prio.cls} title="Приоритет">{prio.text}</span>}
        {due && <span className={due.cls} title={due.title}>{due.text}</span>}
        {/* Повтор — первым: он объясняет, ПОЧЕМУ задача снова на доске. Без значка
            очередная копия выглядит дублем, и её удаляют «как лишнюю». */}
        {task.recurrence_id && (
          <span className="badge badge-repeat" title="Регулярная задача — повторяется по расписанию">
            <Icon name="refresh" size={12} /> повтор
          </span>
        )}
        {!!task.commentsCount && <span className="badge" title="комментарии"><Icon name="chat" size={12} /> {task.commentsCount}</span>}
        {!!task.attachmentsCount && <span className="badge" title="вложения"><Icon name="paperclip" size={12} /> {task.attachmentsCount}</span>}
        {!!task.checklistTotal && <span className="badge" title="чеклист"><Icon name="check" size={12} /> {task.checklistDone}/{task.checklistTotal}</span>}
        {MONETIZATION_ENABLED && cost !== null && (
          <span className="badge" title="Себестоимость в реальном времени">
            ₽ {cost.toLocaleString('ru-RU', { maximumFractionDigits: 0 })}
          </span>
        )}
      </div>
    </div>
  );
}
