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
  @IsOptional() @IsNumber() @Min(0) estimateHours?: number | null;
  /**
   * `null` — убрать срок, отсутствие поля — не трогать.
   *
   * Разница принципиальная: пустое поле в карточке должно СТИРАТЬ срок, а не молча
   * оставлять прежний (на это и жаловались).
   */
  @IsOptional() @IsString() deadlineAt?: string | null;
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
   *
   * Роль member здесь обязательна: срок сотрудник задаёт уже при создании задачи,
   * и запрет на его правку означал бы «завести можно, исправить нельзя».
   */
  @Post(':id/plan')
  @Roles('owner', 'manager', 'member')
  async plan(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: PlanDto) {
    await this.service.setEstimateDeadline(user.tenantId, id, {
      estimate: dto.estimateHours,
      deadline: dto.deadlineAt,
    });
    return { saved: true };
  }

  /**
   * Назначение/перенос с guard перегруза.
   *
   * Сотруднику это тоже можно, и вот почему: задачу он завести МОЖЕТ — сразу с
   * исполнителем и сроком (`POST /tasks`). А поправить их в карточке не мог: две
   * ручки ниже были закрыты для роли member, и человек получал «Insufficient role»
   * на собственной задаче. Права должны совпадать с тем, что уже разрешено при
   * создании, иначе задачу приходится заводить заново вместо правки.
   *
   * Клиент по-прежнему отрезан: он в списке ролей не значится.
   */
  @Post(':id/assign')
  @Roles('owner', 'manager', 'member')
  async assign(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: AssignDto) {
    if (dto.estimateHours !== undefined || dto.deadlineAt !== undefined) {
      await this.service.setEstimateDeadline(user.tenantId, id, {
        estimate: dto.estimateHours,
        deadline: dto.deadlineAt,
      });
    }
    return this.service.assign(user.tenantId, id, dto.assigneeId, user.userId, dto.confirmOverload === true);
  }
}
