import { Controller, ForbiddenException, Get, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../../common/auth/decorators';
import { MediaService } from '../media/media.service';
import { HealthService } from './health.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthService,
    private readonly media: MediaService,
  ) {}

  @Public()
  @Get()
  check() {
    return this.health.check();
  }

  /**
   * Занят ли сервер прямо сейчас — для выкладки без разрыва.
   *
   * Перезапуск API рвёт идущий созвон: состояние комнаты живёт в памяти процесса,
   * и новый контейнер его не подхватит. Поэтому выкладка сначала спрашивает,
   * говорит ли кто-нибудь, и ждёт, пока разговор закончится.
   *
   * Отвечаем ТОЛЬКО на запрос с самой машины: снаружи запрос приходит от nginx из
   * докер-сети, и его адрес не подделать заголовком — сравниваем реальный TCP-адрес,
   * а не `req.ip`, на который влияет X-Forwarded-For.
   */
  @Public()
  @Get('busy')
  busy(@Req() req: Request) {
    const peer = req.socket.remoteAddress ?? '';
    const local = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
    if (!local) throw new ForbiddenException('Только с самого сервера');
    const m = this.media.health();
    return { calls: m.rooms, participants: m.participants };
  }
}
