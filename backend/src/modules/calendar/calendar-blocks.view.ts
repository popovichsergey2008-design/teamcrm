import { BlockRow } from './calendar-blocks.repository';

/** Блок для фронта: подпись — название задачи (блок не копия, открывается сама задача). */
export function blockView(b: BlockRow) {
  return {
    id: String(b.id),
    kind: b.kind,
    taskId: b.task_id ? String(b.task_id) : null,
    taskIds: (b.task_ids ?? []).map(String),
    title: b.kind === 'task' ? (b.task_title ?? b.title ?? 'Задача') : (b.title ?? 'Глубокий фокус'),
    projectId: b.task_project_id ? String(b.task_project_id) : null,
    projectName: b.task_project_name,
    deadlineAt: b.task_deadline_at ? b.task_deadline_at.toISOString() : null,
    taskDone: b.task_status === 'DONE',
    startsAt: b.starts_at.toISOString(),
    endsAt: b.ends_at.toISOString(),
  };
}
