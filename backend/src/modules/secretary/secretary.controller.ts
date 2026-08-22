import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { SecretaryService } from './secretary.service';

/**
 * «AI Секретарь»: что система сделала за людей сама.
 *
 * Журнал общий по организации, а не личный: ценность как раз в том, чтобы видеть
 * работу целиком — задачи со встреч, стендапы, черновики из писем. Прятать от
 * сотрудника, что ассистент разложил задачи коллеге, незачем.
 */
@ApiTags('secretary')
@ApiBearerAuth()
@Controller('secretary')
@Roles('owner', 'manager', 'member')
export class SecretaryController {
  constructor(private readonly secretary: SecretaryService) {}

  /** @param tz смещение часового пояса в минутах (Date#getTimezoneOffset) */
  @Get('summary')
  summary(@CurrentUser() user: AuthUser, @Query('tz') tz?: string) {
    return this.secretary.summary(user.tenantId, Number.parseInt(tz ?? '0', 10) || 0);
  }

  @Get('log')
  feed(@CurrentUser() user: AuthUser, @Query('limit') limit?: string) {
    return this.secretary.feed(user.tenantId, Number.parseInt(limit ?? '50', 10) || 50);
  }
}
