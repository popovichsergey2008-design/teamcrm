import { DragEvent, useState } from 'react';
import type { BoardColumn, Task, User } from '../types';

interface Props {
  column: BoardColumn;
  users?: User[];
  canEdit: boolean;
  canTrack: boolean;
  canManage?: boolean;
  isFirst?: boolean;
  isLast?: boolean;
  activeTimerTask: string | null;
  onAddTask: (columnId: string, title: string) => void;
  onMoveTask: (taskId: string, columnId: string, position: number) => void;
  onToggleTimer: (taskId: string) => void;
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
  canTrack,
  canManage = false,
  isFirst = false,
  isLast = false,
  activeTimerTask,
  onAddTask,
  onMoveTask,
  onToggleTimer,
  onOpenTask,
  onRenameColumn,
  onMoveColumn,
  onDeleteColumn,
  onColumnDrop,
}: Props) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
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

  const submitTask = () => {
    if (title.trim()) onAddTask(column.id, title.trim());
    setTitle('');
    setAdding(false);
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
              <button className="col-btn" title="Влево" disabled={isFirst} onClick={() => onMoveColumn?.(column.id, 'left')}>◀</button>
              <button className="col-btn" title="Вправо" disabled={isLast} onClick={() => onMoveColumn?.(column.id, 'right')}>▶</button>
              <button className="col-btn col-del" title="Удалить колонку" onClick={() => onDeleteColumn?.(column.id, column.name)}>✕</button>
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
            canEdit={canEdit}
            canTrack={canTrack}
            timerActive={activeTimerTask === t.id}
            onToggleTimer={onToggleTimer}
            onOpen={() => onOpenTask(t)}
            onDropBefore={(e) => onDropCard(e, i)}
          />
        ))}
      </div>

      {canEdit &&
        (adding ? (
          <div className="add-task">
            <input
              className="input"
              autoFocus
              value={title}
              placeholder="Название задачи"
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitTask();
                if (e.key === 'Escape') setAdding(false);
              }}
              onBlur={submitTask}
            />
          </div>
        ) : (
          <button className="btn btn-ghost btn-sm add-task-btn" onClick={() => setAdding(true)}>
            + Задача
          </button>
        ))}
    </div>
  );
}

function TaskCard({
  task,
  assigneeName,
  canEdit,
  canTrack,
  timerActive,
  onToggleTimer,
  onOpen,
  onDropBefore,
}: {
  task: Task;
  assigneeName: string | null;
  canEdit: boolean;
  canTrack: boolean;
  timerActive: boolean;
  onToggleTimer: (taskId: string) => void;
  onOpen: () => void;
  onDropBefore: (e: DragEvent) => void;
}) {
  const cost = task.cost_current !== undefined ? Number(task.cost_current) : null;
  return (
    <div
      className={`task-card ${timerActive ? 'task-tracking' : ''}`}
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
      </div>
      <div className="task-meta">
        {assigneeName && (
          <span className="assignee-chip" title={`Исполнитель: ${assigneeName}`}>
            <span className="avatar-xs avatar-ph">{assigneeName[0]?.toUpperCase()}</span>
            {assigneeName}
          </span>
        )}
        {task.is_blocked && <span className="badge badge-blocked">BLOCKED</span>}
        {(task.priority === 'high' || task.priority === 'urgent') && (
          <span className={`badge prio-${task.priority}`}>{task.priority === 'urgent' ? '🔥 срочно' : '↑ высокий'}</span>
        )}
        {!!task.commentsCount && <span className="badge" title="комментарии">💬 {task.commentsCount}</span>}
        {!!task.attachmentsCount && <span className="badge" title="вложения">📎 {task.attachmentsCount}</span>}
        {!!task.checklistTotal && <span className="badge" title="чеклист">✓ {task.checklistDone}/{task.checklistTotal}</span>}
        {cost !== null && (
          <span className="badge" title="Себестоимость в реальном времени">
            ₽ {cost.toLocaleString('ru-RU', { maximumFractionDigits: 0 })}
          </span>
        )}
      </div>
      {canTrack && (
        <button
          className={`btn btn-sm timer-btn ${timerActive ? 'timer-on' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggleTimer(task.id);
          }}
        >
          {timerActive ? '⏸ Пауза' : '▶ В работу'}
        </button>
      )}
    </div>
  );
}
