import { Injectable } from '@nestjs/common';
import { ProjectsRepository } from '../projects/projects.repository';
import { ProjectsService } from '../projects/projects.service';
import { TasksService } from '../tasks/tasks.service';
import { isStarterDescription, reshapeColumns, sphereFromText, StarterSphere, starterPlan, teamFromText } from './starter-plan';

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

  async create(a: { tenantId: string; userId: string; role?: string }, input: {
    sphere: StarterSphere; sphereText?: string | null; name: string; team: boolean; projectId?: string | null;
  }) {
    const plan = starterPlan(input);
    // #4632: «Назад» в боте и другой ответ — правим уже созданный проект, второй не заводим
    if (input.projectId) return this.revise(a, String(input.projectId), plan);

    const project = await this.projects.create(a.tenantId, {
      name: plan.name, description: plan.description, aliases: [],
    }, { columns: plan.columns }) as { id: string | number; name: string };
    const projectId = String(project.id);
    const columns = await this.columns(a.tenantId, projectId);
    const taskIds: string[] = [];
    for (const title of plan.examples) {
      // на самого человека: доска по умолчанию показывает «мои», и чужие примеры он бы не увидел
      const task = await this.tasks.create(a.tenantId, {
        projectId, columnId: columns[0]?.id, title, assigneeId: a.userId, managerId: a.userId,
        description: 'Пример задачи от Qevo-бота: её можно переименовать, передвинуть или удалить.',
      } as never, a.userId);
      taskIds.push(String(task.id));
    }
    return { projectId, name: project.name, columns, taskIds, revised: false };
  }

  /**
   * Тот же проект с новыми ответами: другое имя — переименовать; другой вариант
   * «один / с командой» — перестроить колонки, если они ещё от бота. Описание
   * переписываем, только если его не трогал человек. Примеры задач не дублируем.
   * Чужой организации проект не найдётся — 404 из getOrThrow.
   */
  private async revise(a: { tenantId: string; userId: string; role?: string }, projectId: string, plan: ReturnType<typeof starterPlan>) {
    const project = await this.projects.getOrThrow(a.tenantId, projectId);
    const patch: { name?: string; description?: string } = {};
    if (project.name !== plan.name) patch.name = plan.name;
    if (isStarterDescription(project.description) && project.description !== plan.description) patch.description = plan.description;
    if (patch.name !== undefined || patch.description !== undefined) {
      await this.projects.update(a.tenantId, projectId, { userId: a.userId, role: a.role ?? 'member' }, patch);
    }
    const before = await this.projectsRepo.listColumns(a.tenantId, projectId);
    for (const op of reshapeColumns(before.map((c) => c.name), plan.columns)) {
      if (op.op === 'rename') await this.projects.renameColumn(a.tenantId, projectId, String(before[op.index].id), op.name);
      else if (op.op === 'add') await this.projects.addColumn(a.tenantId, projectId, op.name);
      else await this.projects.deleteColumn(a.tenantId, projectId, String(before[op.index].id));
    }
    return { projectId, name: patch.name ?? project.name, columns: await this.columns(a.tenantId, projectId), taskIds: [] as string[], revised: true };
  }

  private async columns(tenantId: string, projectId: string) {
    return (await this.projectsRepo.listColumns(tenantId, projectId)).map((c) => ({ id: String(c.id), name: c.name }));
  }
}
