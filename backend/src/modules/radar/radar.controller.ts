import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { RadarService } from './radar.service';

/** «Пульс команды» — экран руководителя. Рядовому сотруднику он не показывается. */
@ApiTags('radar')
@ApiBearerAuth()
@Controller('radar')
@Roles('owner', 'manager')
export class RadarController {
  constructor(private readonly radar: RadarService) {}

  /** @param tz смещение часового пояса в минутах (Date#getTimezoneOffset) */
  @Get()
  overview(@CurrentUser() user: AuthUser, @Query('tz') tz?: string) {
    return this.radar.overview(user.tenantId, user.userId, Number.parseInt(tz ?? '0', 10) || 0);
  }
}
