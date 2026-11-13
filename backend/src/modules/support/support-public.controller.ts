import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
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
    const body = publicStatus(await this.concierge.availability());
    this.cache = { at: Date.now(), body };
    return body;
  }
}

type Availability = Awaited<ReturnType<SupportConciergeService['availability']>>;

/** Наружу — только имя, фото и статус дежурных; медиана — если правда быстрая. */
function publicStatus(a: Availability) {
  const onLine = a.engineers.filter((e) => e.status === 'available' || e.status === 'busy' || e.status === 'in_huddle');
  return {
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
}

/**
 * Тот же статус для сайта на WordPress (#4863): сайт берёт `<api_base>support/status` и
 * ждёт поля сразу, без нашего конверта {ok, data}. api_base сайта —
 * https://app.qevo.one/api/public/site/ (заявки — `leads` там же).
 */
@ApiTags('support')
@Controller('public/site/support')
export class SupportSiteController {
  private cache: { at: number; body: unknown } | null = null;

  constructor(private readonly concierge: SupportConciergeService) {}

  @Public()
  @Get('status')
  async status(@Res() res: Response) {
    if (!this.cache || Date.now() - this.cache.at >= TTL_MS) {
      this.cache = { at: Date.now(), body: publicStatus(await this.concierge.availability()) };
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json(this.cache.body);
  }
}
