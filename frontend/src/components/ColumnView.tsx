import { DragEvent, useState } from 'react';
import type { BoardColumn, Task } from '../types';

interface Props {
  column: BoardColumn;
  canEdit: boolean;
  onAddTask: (columnId: string, title: string) => void;
  onMoveTask: (taskId: string, columnId: string, position: number) => void;
}

export function ColumnView({ column, canEdit, onAddTask, onMoveTask }: Props) {
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
  onDropBefore,
}: {
  task: Task;
  canEdit: boolean;
  onDropBefore: (e: DragEvent) => void;
}) {
  return (
    <div
      className="task-card"
      draggable={canEdit}
      onDragStart={(e) => e.dataTransfer.setData('text/plain', task.id)}
      onDrop={canEdit ? onDropBefore : undefined}
      onDragOver={(e) => canEdit && e.preventDefault()}
    >
      <div className="task-title">{task.title}</div>
      <div className="task-meta">
        {task.is_blocked && <span className="badge badge-blocked">BLOCKED</span>}
        {task.cost_current !== undefined && (
          <span className="badge" title="Себестоимость (Этап 2)">
            ₽ {Number(task.cost_current).toFixed(0)}
          </span>
        )}
      </div>
    </div>
  );
}
