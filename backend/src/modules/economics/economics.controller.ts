import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsNumber, Max, Min } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { EconomicsRepository } from './economics.repository';
import { EconomicsService } from './economics.service';
import { EconomicsProducer } from './economics.producer';

class MarginThresholdDto {
  @IsNumber()
  @Min(0)
  @Max(100)
  threshold!: number;
}

/** Финансовые эндпоинты — только internal-роли; client получает FORBIDDEN (фича №9). */
@ApiTags('economics')
@ApiBearerAuth()
@Controller()
@Roles('owner', 'manager', 'member')
export class EconomicsController {
  constructor(
    private readonly service: EconomicsService,
    private readonly repo: EconomicsRepository,
    private readonly producer: EconomicsProducer,
  ) {}

  @Get('tasks/:id/cost')
  cost(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.getTaskCost(user.tenantId, id);
  }

  @Get('projects/:id/pnl')
  pnl(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.getProjectPnl(user.tenantId, id);
  }

  @Get('projects/:id/economics/timeline')
  timeline(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.getTimeline(user.tenantId, id);
  }

  @Get('alerts')
  alerts(@CurrentUser() user: AuthUser) {
    return this.repo.activeAlerts(user.tenantId);
  }

  @Post('projects/:id/margin-threshold')
  @Roles('owner', 'manager')
  async setThreshold(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: MarginThresholdDto,
  ) {
    const ok = await this.repo.setMarginThreshold(user.tenantId, id, dto.threshold);
    if (!ok) throw AppException.notFound('Project not found');
    // порог изменился → пересчитать P&L/алерты проекта
    await this.producer.enqueue({
      kind: 'recompute_project',
      tenantId: user.tenantId,
      projectId: id,
      reason: 'rate_changed',
      dedupKey: `project:${id}`,
    });
    return { projectId: id, threshold: dto.threshold };
  }
}
