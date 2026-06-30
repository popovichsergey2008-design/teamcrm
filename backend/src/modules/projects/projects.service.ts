import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { RealtimeService } from '../realtime/realtime.service';
import { ProjectRow, ProjectsRepository } from './projects.repository';
import { CreateProjectDto } from './projects.dto';

/** client-представление проекта — без budget (фича №9). */
function toClientProject(row: ProjectRow) {
  const { budget, ...rest } = row;
  void budget;
  return rest;
}

@Injectable()
export class ProjectsService {
  constructor(
    private readonly repo: ProjectsRepository,
    private readonly realtime: RealtimeService,
  ) {}

  async list(tenantId: string, role: string) {
    const rows = await this.repo.list(tenantId);
    return role === 'client' ? rows.map(toClientProject) : rows;
  }

  async create(tenantId: string, dto: CreateProjectDto) {
    return this.repo.create({
      tenantId,
      name: dto.name,
      clientId: dto.clientId ?? null,
      budget: dto.budget ?? null,
    });
  }

  async remove(tenantId: string, id: string) {
    await this.getOrThrow(tenantId, id); // 404, если проект не из этой организации
    await this.repo.deleteCascade(tenantId, id);
    return { deleted: true };
  }

  // ───── управление колонками доски ─────
  private notifyColumns(tenantId: string, projectId: string) {
    this.realtime.emit(tenantId, projectId, 'column.updated', { projectId });
  }

  async addColumn(tenantId: string, projectId: string, name: string) {
    await this.getOrThrow(tenantId, projectId);
    const col = await this.repo.addColumn(tenantId, projectId, name.trim());
    this.notifyColumns(tenantId, projectId);
    return col;
  }

  async renameColumn(tenantId: string, projectId: string, columnId: string, name: string) {
    await this.getOrThrow(tenantId, projectId);
    const col = await this.repo.renameColumn(tenantId, projectId, columnId, name.trim());
    if (!col) throw AppException.notFound('Колонка не найдена');
    this.notifyColumns(tenantId, projectId);
    return col;
  }

  async deleteColumn(tenantId: string, projectId: string, columnId: string) {
    await this.getOrThrow(tenantId, projectId);
    const column = await this.repo.findColumn(tenantId, projectId, columnId);
    if (!column) throw AppException.notFound('Колонка не найдена');
    if ((await this.repo.countColumns(tenantId, projectId)) <= 1) {
      throw AppException.conflict('Нельзя удалить последнюю колонку доски');
    }
    await this.repo.deleteColumn(tenantId, projectId, columnId);
    this.notifyColumns(tenantId, projectId);
    return { deleted: true };
  }

  async moveColumn(tenantId: string, projectId: string, columnId: string, direction: 'left' | 'right') {
    await this.getOrThrow(tenantId, projectId);
    const column = await this.repo.findColumn(tenantId, projectId, columnId);
    if (!column) throw AppException.notFound('Колонка не найдена');
    await this.repo.moveColumn(tenantId, projectId, columnId, direction);
    this.notifyColumns(tenantId, projectId);
    return { moved: true };
  }

  async getOrThrow(tenantId: string, id: string): Promise<ProjectRow> {
    const row = await this.repo.findById(tenantId, id);
    if (!row) throw AppException.notFound('Project not found');
    return row;
  }
}
