import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { runsBackground } from '../../common/process-role';
import { FocusWave2Service } from './focus-wave2.service';

const TICK_MS = 5 * 60_000;

/** #4891, п. 10: в конце рабочего дня — мягкое «Завершить день?», одно в день. */
@Injectable()
export class FocusPlusScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(FocusPlusScheduler.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(private readonly w2: FocusWave2Service) {}

  onModuleInit() {
    if (!runsBackground()) return;
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
      await this.w2.remindClose();
    } catch (e) {
      this.log.warn(`«Завершить день» не разослано: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.busy = false;
    }
  }
}
