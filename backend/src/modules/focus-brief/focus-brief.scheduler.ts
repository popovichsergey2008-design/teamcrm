import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { FocusBriefService } from './focus-brief.service';

const TICK_MS = 5 * 60_000;

/**
 * Утренний брифинг заранее (ТЗ-27, п. 14): раз в пять минут — тем, у кого по их поясу
 * наступило время сборки (по умолчанию 08:30), а снимка ещё нет. Открывший раньше
 * получит его лениво; повтор безопасен — снимок один на день.
 */
@Injectable()
export class FocusBriefScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(FocusBriefScheduler.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(private readonly brief: FocusBriefService) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.brief.morningTick();
    } catch (e) {
      this.log.warn(`утренние брифинги: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.busy = false;
    }
  }
}
