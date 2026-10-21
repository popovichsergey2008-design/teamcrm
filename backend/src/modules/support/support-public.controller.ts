import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/auth/decorators';
import { SupportConciergeService } from './support-concierge.service';

/** Кэш на 30 секунд: страницу открывают все подряд, а статус меняется не так часто. */
const TTL_MS = 30_000;

/**
 * Живой статус «Службы заботы» для рекламной страницы (#4616): кто сейчас на линии и
 * реальное время первого ответа. Наружу — только имя, фото и статус дежурных; ни
 * очереди, ни нагрузки, ни обращений. Нет данных — страница пишет текст без цифр.
 */
@ApiTags('support')
@Controller('public/support')
export class SupportPublicController {
  private cache: { at: number; body: unknown } | null = null;

  constructor(private readonly concierge: SupportConciergeService) {}

  @Public()
  @Get('status')
  async status() {
    if (this.cache && Date.now() - this.cache.at < TTL_MS) return this.cache.body;
    const a = await this.concierge.availability();
    const onLine = a.engineers.filter((e) => e.status === 'available' || e.status === 'busy' || e.status === 'in_huddle');
    const body = {
      online: onLine.length,
      available: a.available,
      // медиана первого ответа человека за 14 дней — только если она правда быстрая
      medianSec: a.medianSec != null && a.medianSec <= 120 ? a.medianSec : null,
      engineers: onLine.slice(0, 4).map((e) => ({
        name: String(e.name ?? '').split(/\s+/)[0] || 'Инженер',
        avatarUrl: e.avatarUrl,
        status: e.status,
      })),
    };
    this.cache = { at: Date.now(), body };
    return body;
  }
}
