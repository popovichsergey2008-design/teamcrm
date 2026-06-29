import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { ProjectsRepository } from '../projects/projects.repository';
import { TasksRepository, TaskRow } from '../tasks/tasks.repository';

/** client-представление задачи — без cost_current (фича №9). */
function toClientTask(t: TaskRow) {
  const { cost_current, ...rest } = t;
  void cost_current;
  return rest;
}

@Injectable()
export class BoardService {
  constructor(
    private readonly projects: ProjectsRepository,
    private readonly tasks: TasksRepository,
  ) {}

  async getBoard(tenantId: string, projectId: string, role: string) {
    const project = await this.projects.findById(tenantId, projectId);
    if (!project) throw AppException.notFound('Project not found');

    const columns = await this.projects.listColumns(tenantId, projectId);
    const tasks = await this.tasks.listByProject(tenantId, projectId);
    const isClient = role === 'client';

    const tasksByColumn = new Map<string, any[]>();
    for (const col of columns) tasksByColumn.set(col.id, []);
    for (const t of tasks) {
      const view = isClient ? toClientTask(t) : t;
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
