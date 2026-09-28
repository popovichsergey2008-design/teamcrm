import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { PlatformService } from '../platform/platform.service';
import { AnalyticsService } from './analytics.service';

/**
 * Продуктовая аналитика: докуда доходят новые организации (ТЗ-11, разд. 56-57).
 *
 * Только техотделу вендора — как и весь остальной «кабинет разработчика». Клиенту эта
 * ручка не нужна и не видна: он не должен знать, как проходят путь другие компании.
 */
@ApiTags('platform')
@ApiBearerAuth()
@Controller('platform')
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly platform: PlatformService,
  ) {}

  @Get('funnel')
  async funnel(@CurrentUser() u: AuthUser) {
    await this.platform.assertStaff(u.userId);
    return this.analytics.report();
  }
}
