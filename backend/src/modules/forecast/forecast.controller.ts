import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { ForecastService } from './forecast.service';

class AssignDto {
  @IsString() assigneeId!: string;
  @IsOptional() @IsBoolean() confirmOverload?: boolean;
  @IsOptional() @IsNumber() @Min(0) estimateHours?: number;
  @IsOptional() @IsString() deadlineAt?: string;
}

class PlanDto {
  @IsOptional() @IsNumber() @Min(0) estimateHours?: number;
  @IsOptional() @IsString() deadlineAt?: string;
}

@ApiTags('forecast')
@ApiBearerAuth()
@Controller('tasks')
export class ForecastController {
  constructor(private readonly service: ForecastService) {}

  /** Прогноз/светофор: дата и цвет — всем ролям; risk_pct — только internal. */
  @Get(':id/forecast')
  forecast(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.getForecast(user.tenantId, id, user.role);
  }

  /**
   * Оценка и срок без назначения.
   *
   * Раньше их можно было сохранить только вместе с исполнителем — кнопка называлась
   * «Назначить» и требовала выбрать человека. Из-за этого поставить срок задаче,
   * которую ещё не на кого повесить, было нельзя: приходилось назначать кого попало.
   */
  @Post(':id/plan')
  @Roles('owner', 'manager')
  async plan(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: PlanDto) {
    await this.service.setEstimateDeadline(
      user.tenantId, id, dto.estimateHours ?? null, dto.deadlineAt ?? null,
    );
    return { saved: true };
  }

  /** Назначение/перенос с guard перегруза (internal-роли). */
  @Post(':id/assign')
  @Roles('owner', 'manager')
  async assign(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: AssignDto) {
    if (dto.estimateHours !== undefined || dto.deadlineAt !== undefined) {
      await this.service.setEstimateDeadline(user.tenantId, id, dto.estimateHours ?? null, dto.deadlineAt ?? null);
    }
    return this.service.assign(user.tenantId, id, dto.assigneeId, user.userId, dto.confirmOverload === true);
  }
}
