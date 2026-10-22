import { Injectable } from '@nestjs/common';
import { ProjectsRepository } from '../projects/projects.repository';
import { ProjectsService } from '../projects/projects.service';
import { TasksService } from '../tasks/tasks.service';
import { sphereFromText, StarterSphere, starterPlan, teamFromText } from './starter-plan';

/**
 * Первый проект от Qevo-бота (#4620): три ответа → проект с этапами и двумя примерами.
 *
 * Через обычные проекты и задачи, а не своими INSERT: у задачи есть журнал изменений,
 * синхронизация с телефоном и события в реальном времени — пример обязан быть
 * такой же задачей, как любая другая, иначе первая же правка его сломает.
 */
@Injectable()
export class StarterService {
  constructor(
    private readonly projects: ProjectsService,
    private readonly projectsRepo: ProjectsRepository,
    private readonly tasks: TasksService,
  ) {}

  /** Свободный ответ (голос или текст) — в сферу или «один / с командой». */
  understand(step: 'sphere' | 'team', text: string) {
    return step === 'sphere' ? { sphere: sphereFromText(text) } : { team: teamFromText(text) };
  }

  async create(a: { tenantId: string; userId: string }, input: {
    sphere: StarterSphere; sphereText?: string | null; name: string; team: boolean;
  }) {
    const plan = starterPlan(input);
    const project = await this.projects.create(a.tenantId, {
      name: plan.name, description: plan.description, aliases: [],
    }, { columns: plan.columns }) as { id: string | number; name: string };
    const projectId = String(project.id);
    const columns = (await this.projectsRepo.listColumns(a.tenantId, projectId)).map((c) => ({ id: String(c.id), name: c.name }));
    const taskIds: string[] = [];
    for (const title of plan.examples) {
      // на самого человека: доска по умолчанию показывает «мои», и чужие примеры он бы не увидел
      const task = await this.tasks.create(a.tenantId, {
        projectId, columnId: columns[0]?.id, title, assigneeId: a.userId, managerId: a.userId,
        description: 'Пример задачи от Qevo-бота: её можно переименовать, передвинуть или удалить.',
      } as never, a.userId);
      taskIds.push(String(task.id));
    }
    return { projectId, name: project.name, columns, taskIds };
  }
}
