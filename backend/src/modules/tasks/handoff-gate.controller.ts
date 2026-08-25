import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { TasksService } from './tasks.service';

class GateDto {
  @IsBoolean() checklist!: boolean;
  @IsBoolean() comment!: boolean;
  @IsBoolean() attachment!: boolean;
}

/**
 * Условия приёмки работы — общие для компании.
 *
 * Читают все сотрудники: правило, по которому у тебя не примут работу, не может
 * быть тайным. Меняет владелец — как и рабочие часы: это часть договорённости
 * о том, как здесь работают, а не личная настройка того, кому проверка мешает.
 */
@ApiTags('tasks')
@ApiBearerAuth()
@Controller('handoff-gate')
@Roles('owner', 'manager', 'member')
export class HandoffGateController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.tasks.gateSettings(user.tenantId);
  }

  @Put()
  save(@CurrentUser() user: AuthUser, @Body() dto: GateDto) {
    return this.tasks.saveGateSettings(user.tenantId, user.role, dto);
  }
}
