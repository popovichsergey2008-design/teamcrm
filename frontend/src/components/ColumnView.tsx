import { DragEvent, useState } from 'react';
import type { BoardColumn, Task } from '../types';

interface Props {
  column: BoardColumn;
  canEdit: boolean;
  canTrack: boolean;
  activeTimerTask: string | null;
  onAddTask: (columnId: string, title: string) => void;
  onMoveTask: (taskId: string, columnId: string, position: number) => void;
  onToggleTimer: (taskId: string) => void;
}

export function ColumnView({
  column,
  canEdit,
  canTrack,
  activeTimerTask,
  onAddTask,
  onMoveTask,
  onToggleTimer,
}: Props) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [over, setOver] = useState(false);

  const submitTask = () => {
    if (title.trim()) onAddTask(column.id, title.trim());
    setTitle('');
    setAdding(false);
  };

  const onDropColumn = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const taskId = e.dataTransfer.getData('text/plain');
    if (taskId) onMoveTask(taskId, column.id, column.tasks.length);
  };

  const onDropCard = (e: DragEvent, index: number) => {
    e.preventDefault();
    e.stopPropagation();
    setOver(false);
    const taskId = e.dataTransfer.getData('text/plain');
    if (taskId) onMoveTask(taskId, column.id, index);
  };

  return (
    <div
      className={`column ${over ? 'column-over' : ''}`}
      onDragOver={(e) => {
        if (canEdit) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={canEdit ? onDropColumn : undefined}
    >
      <div className="column-head">
        <span>{column.name}</span>
        <span className="badge">{column.tasks.length}</span>
      </div>

      <div className="column-tasks">
        {column.tasks.map((t, i) => (
          <TaskCard
            key={t.id}
            task={t}
            canEdit={canEdit}
            canTrack={canTrack}
            timerActive={activeTimerTask === t.id}
            onToggleTimer={onToggleTimer}
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
  canEdit,
  canTrack,
  timerActive,
  onToggleTimer,
  onDropBefore,
}: {
  task: Task;
  canEdit: boolean;
  canTrack: boolean;
  timerActive: boolean;
  onToggleTimer: (taskId: string) => void;
  onDropBefore: (e: DragEvent) => void;
}) {
  const cost = task.cost_current !== undefined ? Number(task.cost_current) : null;
  return (
    <div
      className={`task-card ${timerActive ? 'task-tracking' : ''}`}
      draggable={canEdit}
      onDragStart={(e) => e.dataTransfer.setData('text/plain', task.id)}
      onDrop={canEdit ? onDropBefore : undefined}
      onDragOver={(e) => canEdit && e.preventDefault()}
    >
      <div className="task-title">
        {task.risk_level && <span className={`risk-dot risk-${task.risk_level}`} title={`Риск срока: ${task.risk_level}`} />}
        {task.title}
      </div>
      <div className="task-meta">
        {task.is_blocked && <span className="badge badge-blocked">BLOCKED</span>}
        {cost !== null && (
          <span className="badge" title="Себестоимость в реальном времени">
            ₽ {cost.toLocaleString('ru-RU', { maximumFractionDigits: 0 })}
          </span>
        )}
      </div>
      {canTrack && (
        <button
          className={`btn btn-sm timer-btn ${timerActive ? 'timer-on' : ''}`}
          onClick={() => onToggleTimer(task.id)}
        >
          {timerActive ? '⏸ Пауза' : '▶ В работу'}
        </button>
      )}
    </div>
  );
}
