import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { NavService } from './nav.service';

/**
 * Счётчики для левой панели.
 *
 * Одна ручка на все бейджи: панель видна всегда, и четыре запроса на каждое
 * переключение раздела превратились бы в постоянный фоновый шум к базе.
 */
@ApiTags('nav')
@ApiBearerAuth()
@Controller('nav')
@Roles('owner', 'manager', 'member') // у клиента свой портал, панели он не видит
export class NavController {
  constructor(private readonly nav: NavService) {}

  /** @param tz смещение часового пояса в минутах, как его отдаёт браузер (Date#getTimezoneOffset) */
  @Get('counters')
  counters(@CurrentUser() user: AuthUser, @Query('tz') tz?: string) {
    return this.nav.counters(user.tenantId, user.userId, user.role, Number.parseInt(tz ?? '0', 10) || 0);
  }
}
