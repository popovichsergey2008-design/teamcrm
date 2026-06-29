import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { RealtimeService } from '../realtime/realtime.service';
import { DealRow, DealsRepository } from './deals.repository';
import { CreateDealDto } from './deals.dto';

@Injectable()
export class DealsService {
  constructor(
    private readonly repo: DealsRepository,
    private readonly realtime: RealtimeService,
  ) {}

  list(tenantId: string): Promise<DealRow[]> {
    return this.repo.list(tenantId);
  }

  create(tenantId: string, dto: CreateDealDto): Promise<DealRow> {
    return this.repo.create({
      tenantId,
      title: dto.title,
      stage: dto.stage ?? 'new',
      clientId: dto.clientId ?? null,
      amount: dto.amount ?? null,
      plannedMargin: dto.plannedMargin ?? null,
    });
  }

  async convert(tenantId: string, id: string) {
    const deal = await this.repo.findById(tenantId, id);
    if (!deal) throw AppException.notFound('Deal not found');
    if (deal.project_id) throw AppException.conflict('Deal already converted');

    const { deal: updatedDeal, project } = await this.repo.convert(tenantId, deal);
    // событие в комнату нового проекта; client-комната не получит финансовых полей
    this.realtime.emit(tenantId, project.id, 'deal.converted', {
      dealId: updatedDeal.id,
      projectId: project.id,
      projectName: project.name,
    });
    return { deal: updatedDeal, project };
  }
}
