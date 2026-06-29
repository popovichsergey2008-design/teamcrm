import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
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
  constructor(private readonly repo: ProjectsRepository) {}

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

  async getOrThrow(tenantId: string, id: string): Promise<ProjectRow> {
    const row = await this.repo.findById(tenantId, id);
    if (!row) throw AppException.notFound('Project not found');
    return row;
  }
}
