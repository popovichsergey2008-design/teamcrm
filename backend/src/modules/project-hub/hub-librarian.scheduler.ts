import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { HubLibrarianService } from './hub-librarian.service';

/**
 * Тик библиотекаря раз в пять минут — по образцу разбора переписки. Чаще незачем:
 * прогон раз в утро, а пять минут опоздания к 08:00 никто не заметит. Утро проекта
 * занимается строкой в базе, поэтому второй экземпляр API (blue/green) не повторит прогон.
 */
const TICK_MS = 5 * 60_000;

@Injectable()
export class HubLibrarianScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('HubLibrarianTick');
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(private readonly svc: HubLibrarianService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    // unref: незавершённый таймер не должен держать процесс при остановке
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Проходы не накладываются: модель бывает медленной. */
  async tick(now = new Date()): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    try {
      const n = await this.svc.tick(now);
      if (n) this.log.log(`Инфоцентр: собрано проектов ${n}`);
      return n;
    } catch (e) {
      this.log.error(`проход не удался: ${(e as Error).message}`);
      return 0;
    } finally {
      this.busy = false;
    }
  }
}
