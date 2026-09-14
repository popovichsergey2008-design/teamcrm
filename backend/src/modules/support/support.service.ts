import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { ProjectsService } from '../projects/projects.service';
import { TasksService } from '../tasks/tasks.service';
import { SupportRepository } from './support.repository';

/** Имя проекта, который заводится сам, пока руководитель не выбрал свой. */
const DEFAULT_PROJECT_NAME = 'Поддержка';

/**
 * Поддержка — кнопка в левой панели.
 *
 * Обращение становится задачей в проекте поддержки: постановщик — кто обратился,
 * исполнитель — владелец компании. Дальше это обычная задача: с перепиской,
 * файлами, статусами и уведомлениями — писать вторую систему заявок незачем.
 */
@Injectable()
export class SupportService {
  constructor(
    private readonly repo: SupportRepository,
    private readonly projects: ProjectsService,
    private readonly tasks: TasksService,
  ) {}

  /** Что показать на странице: проект поддержки (если назначен) и мои обращения. */
  async overview(tenantId: string, userId: string) {
    const project = await this.repo.project(tenantId);
    const tickets = project ? await this.repo.mine(tenantId, project.id, userId) : [];
    return {
      project,
      tickets: tickets.map((t) => ({
        id: String(t.id), title: t.title, status: t.status, closed: !!t.closed_at,
        createdAt: t.created_at, projectId: String(t.project_id), assigneeName: t.assignee_name,
      })),
    };
  }

  /** Назначить или снять проект поддержки — из настроек проекта. */
  async setProject(tenantId: string, projectId: string, isSupport: boolean) {
    await this.projects.getOrThrow(tenantId, projectId); // 404, если проект не из этой организации
    if (isSupport) await this.repo.setProject(tenantId, projectId);
    else await this.repo.unsetProject(tenantId, projectId);
    return { isSupport };
  }

  /**
   * Обращение.
   *
   * Проект поддержки заводится сам, если его ещё не выбрали: человек с проблемой
   * не должен упираться в «сначала настройте». Руководитель потом может назначить
   * другой проект — обращения пойдут туда.
   */
  async create(tenantId: string, user: { userId: string }, input: { title: string; description?: string }) {
    const title = input.title.trim();
    if (!title) throw AppException.validation('Опишите, что случилось, — хотя бы одной строкой');
    let project = await this.repo.project(tenantId);
    if (!project) {
      const created = await this.projects.create(tenantId, { name: DEFAULT_PROJECT_NAME });
      await this.repo.setProject(tenantId, String(created.id));
      project = { id: String(created.id), name: created.name };
    }
    const owner = await this.repo.ownerId(tenantId);
    const task = await this.tasks.create(tenantId, {
      projectId: String(project.id),
      title: title.slice(0, 500),
      description: input.description?.trim() || undefined,
      // Себе же обращение не назначаем: владелец пишет в поддержку — задача без исполнителя,
      // иначе он получил бы уведомление о собственной просьбе.
      assigneeId: owner && String(owner.id) !== String(user.userId) ? String(owner.id) : undefined,
      managerId: user.userId,
      priority: 'normal',
    }, user.userId);
    return { id: String(task.id), projectId: String(project.id), title: task.title };
  }
}
