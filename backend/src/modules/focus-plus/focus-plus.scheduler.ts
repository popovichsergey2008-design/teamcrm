import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { runsBackground } from '../../common/process-role';
import { FocusHabitService } from './focus-habit.service';
import { FocusWave2Service } from './focus-wave2.service';

const TICK_MS = 5 * 60_000;

/** #4891: план утром и итоги недели (п. 12), мягкое «Завершить день?» в конце дня (п. 10). */
@Injectable()
export class FocusPlusScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(FocusPlusScheduler.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(private readonly w2: FocusWave2Service, private readonly habit: FocusHabitService) {}

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
      await this.habit.sendMorning();
      await this.habit.sendWeekly();
      await this.w2.remindClose();
    } catch (e) {
      this.log.warn(`рассылки Фокуса: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.busy = false;
    }
  }
}
