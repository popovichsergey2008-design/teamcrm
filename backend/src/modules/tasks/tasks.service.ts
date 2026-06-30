import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { ProjectsRepository } from '../projects/projects.repository';
import { RealtimeService } from '../realtime/realtime.service';
import { TaskRow, TasksRepository } from './tasks.repository';
import { TaskActivityRepository } from './task-activity.repository';
import { CreateTaskDto, MoveTaskDto, UpdateTaskDto } from './tasks.dto';

/** Колонка-«готово» (закрывает задачу): дефолтное 'done' + распространённые русские имена. */
const DONE_NAMES = new Set(['done', 'готово', 'выполнено', 'завершено', 'завершён', 'завершен', 'закрыто', 'сделано']);
function isDoneColumn(name: string): boolean {
  return DONE_NAMES.has(name.trim().toLowerCase());
}

@Injectable()
export class TasksService {
  constructor(
    private readonly repo: TasksRepository,
    private readonly projects: ProjectsRepository,
    private readonly realtime: RealtimeService,
    private readonly activity: TaskActivityRepository,
  ) {}

  async create(tenantId: string, dto: CreateTaskDto, actorId: string | null = null): Promise<TaskRow> {
    const project = await this.projects.findById(tenantId, dto.projectId);
    if (!project) throw AppException.notFound('Project not found');

    const columns = await this.projects.listColumns(tenantId, dto.projectId);
    if (columns.length === 0) throw AppException.conflict('Project has no columns');
    const column = dto.columnId
      ? columns.find((c) => c.id === dto.columnId)
      : columns[0];
    if (!column) throw AppException.notFound('Column not found');

    const task = await this.repo.create({
      tenantId,
      projectId: dto.projectId,
      columnId: column.id,
      status: column.name,
      title: dto.title,
      description: dto.description ?? null,
      assigneeId: dto.assigneeId ?? null,
    });
    this.realtime.emit(tenantId, task.project_id, 'task.created', task as any);
    await this.activity.log(tenantId, task.id, actorId, 'created', { title: task.title });
    return task;
  }

  async update(tenantId: string, id: string, dto: UpdateTaskDto, actorId: string | null = null): Promise<TaskRow> {
    const existing = await this.repo.findById(tenantId, id);
    if (!existing) throw AppException.notFound('Task not found');

    const updated = await this.repo.update(tenantId, id, {
      title: dto.title,
      description: dto.description,
      assignee_id: dto.assigneeId,
      is_blocked: dto.isBlocked,
      priority: dto.priority,
    });
    this.realtime.emit(tenantId, existing.project_id, 'task.updated', updated as any);
    const changed = Object.keys(dto).filter((k) => (dto as any)[k] !== undefined);
    await this.activity.log(tenantId, id, actorId, 'updated', { fields: changed });
    return updated as TaskRow;
  }

  async move(tenantId: string, id: string, dto: MoveTaskDto, actorId: string | null = null): Promise<TaskRow> {
    const task = await this.repo.findById(tenantId, id);
    if (!task) throw AppException.notFound('Task not found');

    const column = await this.projects.findColumn(tenantId, task.project_id, dto.columnId);
    if (!column) throw AppException.notFound('Target column not found');

    const moved = await this.repo.move(tenantId, id, dto.columnId, dto.position, column.name);
    // перенос в Done закрывает задачу (источник для Velocity/эмбеддингов); вынос — переоткрывает
    if (isDoneColumn(column.name)) await this.repo.closeTask(tenantId, id);
    else if (task.closed_at) await this.repo.reopenTask(tenantId, id);
    this.realtime.emit(tenantId, moved.project_id, 'task.moved', moved as any);
    await this.activity.log(tenantId, id, actorId, 'moved', { to: column.name });
    return moved;
  }
}
