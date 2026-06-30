import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { ProjectsRepository } from '../projects/projects.repository';
import { TasksRepository, TaskRow } from '../tasks/tasks.repository';
import { TaskCardRepository } from '../taskcard/taskcard.repository';

/** client-представление задачи — без финансов и внутренних метрик (фичи №9/№8).
 *  Дата прогноза и цвет светофора клиенту видны; cost_current и risk_pct — нет. */
function toClientTask(t: TaskRow & { risk_pct?: unknown }) {
  const { cost_current, risk_pct, ...rest } = t;
  void cost_current;
  void risk_pct;
  return rest;
}

@Injectable()
export class BoardService {
  constructor(
    private readonly projects: ProjectsRepository,
    private readonly tasks: TasksRepository,
    private readonly card: TaskCardRepository,
  ) {}

  async getBoard(tenantId: string, projectId: string, role: string) {
    const project = await this.projects.findById(tenantId, projectId);
    if (!project) throw AppException.notFound('Project not found');

    const columns = await this.projects.listColumns(tenantId, projectId);
    const tasks = await this.tasks.listByProject(tenantId, projectId);
    const isClient = role === 'client';

    // обогащение карточек: метки + счётчики (комментарии/вложения/чеклист)
    const { labels, counts } = await this.card.boardMeta(tenantId, projectId);
    const labelsByTask = new Map<string, any[]>();
    for (const l of labels) {
      const arr = labelsByTask.get(l.task_id) ?? [];
      arr.push({ id: l.id, name: l.name, color: l.color });
      labelsByTask.set(l.task_id, arr);
    }
    const countsByTask = new Map<string, any>();
    for (const c of counts) countsByTask.set(c.task_id, c);

    const enrich = (t: any) => {
      const c = countsByTask.get(t.id);
      return {
        ...t,
        labels: labelsByTask.get(t.id) ?? [],
        commentsCount: c ? Number(c.comments) : 0,
        attachmentsCount: c ? Number(c.attachments) : 0,
        checklistTotal: c ? Number(c.cl_total) : 0,
        checklistDone: c ? Number(c.cl_done) : 0,
      };
    };

    const tasksByColumn = new Map<string, any[]>();
    for (const col of columns) tasksByColumn.set(col.id, []);
    for (const t of tasks) {
      const view = enrich(isClient ? toClientTask(t) : t);
      tasksByColumn.get(t.column_id)?.push(view);
    }

    const projectView = isClient
      ? (({ budget, ...rest }) => {
          void budget;
          return rest;
        })(project)
      : project;

    return {
      project: projectView,
      columns: columns.map((c) => ({
        id: c.id,
        name: c.name,
        position: c.position,
        tasks: tasksByColumn.get(c.id) ?? [],
      })),
    };
  }
}
