import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { NewsAgentService } from './news-agent.service';

/** Раз в пять минут: хайлайт выходит в своё окно (час из настроек + 3 ч), опросы закрываются вовремя. */
const TICK_MS = 5 * 60_000;

/**
 * Планировщик «Новостей» (ТЗ-20, §67). Как остальные планировщики продукта —
 * таймер, а не cron: две копии сервера (blue/green) безопасны, потому что каждый
 * пост защищён ключом дня или недели, а закрытие опроса — условием «ещё открыт».
 */
@Injectable()
export class NewsScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('NewsScheduler');
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(private readonly agent: NewsAgentService) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    this.timer.unref?.();
    setTimeout(() => { void this.tick(); }, 30_000).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.agent.tick();
    } catch (e) {
      this.log.warn(`новости: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}
