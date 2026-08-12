import { Controller, Param, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Public } from '../../../common/auth/decorators';
import { YougileService } from './yougile.service';

/**
 * Приёмник вебхуков YouGile (E3, живая синхронизация). Публичный (YouGile не шлёт наш JWT);
 * маршрутизация — по секретному event_token в пути. Отвечаем быстро, синхронизация — фоново.
 */
@ApiTags('integrations/yougile')
@Controller('integrations/yougile/events')
export class YougileEventsController {
  constructor(private readonly yougile: YougileService) {}

  @Public()
  @Post(':token')
  event(@Param('token') token: string, @Req() req: Request) {
    return this.yougile.handleEvent(token, req.body);
  }
}
