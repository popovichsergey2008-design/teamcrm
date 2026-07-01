import { Controller, Param, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Public } from '../../../common/auth/decorators';
import { BitrixService } from './bitrix.service';

/**
 * Приёмник исходящих событий Битрикса (E3, живая синхронизация).
 * Публичный (Битрикс не шлёт наш JWT); маршрутизация — по секретному event_token в пути.
 */
@ApiTags('integrations/bitrix')
@Controller('integrations/bitrix/events')
export class BitrixEventsController {
  constructor(private readonly bitrix: BitrixService) {}

  @Public()
  @Post(':token')
  async event(@Param('token') token: string, @Req() req: Request) {
    // Битрикс шлёт application/x-www-form-urlencoded с вложенными ключами (data[FIELDS_AFTER][ID])
    await this.bitrix.handleEvent(token, req.body);
    return { received: true };
  }
}
