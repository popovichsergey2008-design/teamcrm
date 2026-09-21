import { Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { SessionsService } from './sessions.service';

/**
 * Устройства и сессии сотрудников — руководству (ТЗ-9, волна 3).
 *
 * Потерянный телефон, уволенный сотрудник: владелец или руководитель отзывает
 * сессию, и та перестаёт работать сразу — не через четверть часа.
 */
@ApiTags('team')
@ApiBearerAuth()
@Controller('team')
@Roles('owner', 'manager')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get(':userId/sessions')
  list(@CurrentUser() u: AuthUser, @Param('userId') userId: string) {
    return this.sessions.ofEmployee(u.tenantId, userId);
  }

  @Delete(':userId/sessions/:sessionId')
  async revoke(@CurrentUser() u: AuthUser, @Param('userId') userId: string, @Param('sessionId') sessionId: string) {
    await this.sessions.revokeEmployee(u.tenantId, userId, sessionId);
    return { revoked: true };
  }

  @Post(':userId/sessions/revoke-all')
  async revokeAll(@CurrentUser() u: AuthUser, @Param('userId') userId: string) {
    await this.sessions.revokeEmployee(u.tenantId, userId, null);
    return { revoked: true };
  }
}