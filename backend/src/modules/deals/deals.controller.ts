import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { DealsService } from './deals.service';
import { CreateDealDto } from './deals.dto';
import { SecurityService } from '../security/security.service';

@ApiTags('deals')
@ApiBearerAuth()
@Controller('deals')
// Права — `crm.view` / `crm.edit` слоя безопасности (ТЗ-17, волна 0): раньше здесь стояла
// жёсткая роль, а быстрая команда пускала сотрудника — правило было разным в двух местах.
@Roles('owner', 'manager', 'member')
export class DealsController {
  constructor(private readonly deals: DealsService, private readonly security: SecurityService) {}

  @Get()
  async list(@CurrentUser() user: AuthUser) {
    await this.security.require(user.tenantId, user.userId, 'crm.view', 'Сделки вам не открыты');
    return this.deals.list(user.tenantId);
  }

  @Post()
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateDealDto) {
    await this.security.require(user.tenantId, user.userId, 'crm.edit', 'Заводить сделки вам не разрешено');
    return this.deals.create(user.tenantId, dto);
  }

  @Post(':id/convert')
  async convert(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.security.require(user.tenantId, user.userId, 'crm.edit', 'Переводить сделки в проект вам не разрешено');
    return this.deals.convert(user.tenantId, id);
  }
}
