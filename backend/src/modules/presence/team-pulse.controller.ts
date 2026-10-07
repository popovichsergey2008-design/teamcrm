import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { SecurityService } from '../security/security.service';
import { PresenceService } from './presence.service';

/**
 * «Команда сейчас» (ТЗ-16, п. 61–68): кто свободен, кто в глубоком фокусе, кто на
 * созвоне — чтобы не писать «ты свободен?».
 *
 * Видят все сотрудники (решение заказчика), право `focus.view_team` позволяет
 * владельцу закрыть это кому-то отдельно. Активность клавиатуры, мыши и экраны не
 * собираются и собираться не будут (п. 109): только то, что человек поставил сам,
 * и то, что видно и так — в сети ли он и в созвоне ли.
 */
@ApiTags('focus')
@ApiBearerAuth()
@Controller('team/pulse')
@Roles('owner', 'manager', 'member')
export class TeamPulseController {
  constructor(private readonly presence: PresenceService, private readonly security: SecurityService) {}

  @Get()
  async team(@CurrentUser() u: AuthUser) {
    await this.security.require(u.tenantId, u.userId, 'focus.view_team', 'Список «Команда сейчас» вам закрыт — его открывает владелец организации');
    return this.presence.team(u.tenantId, { userId: u.userId, role: u.role });
  }

  /** Один человек — по событию `presence.updated` клиент дозапрашивает название задачи. */
  @Get(':userId')
  async one(@CurrentUser() u: AuthUser, @Param('userId') userId: string) {
    await this.security.require(u.tenantId, u.userId, 'focus.view_team', 'Список «Команда сейчас» вам закрыт — его открывает владелец организации');
    const [p] = await this.presence.team(u.tenantId, { userId: u.userId, role: u.role }, userId);
    return p ?? null;
  }
}
