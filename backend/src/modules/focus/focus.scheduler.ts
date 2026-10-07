import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { FocusSessionService } from './focus-session.service';

const TICK_MS = 30_000;

/**
 * Конец глубокого фокуса (ТЗ-16, волна 8): раз в полминуты отмечаем сессии, у
 * которых вышло время, — телефон получает «Фокус завершён», а коллеги видят, что
 * человек снова доступен. Повтор безопасен: каждая сессия отмечается один раз.
 */
@Injectable()
export class FocusScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(FocusScheduler.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(private readonly sessions: FocusSessionService) {}

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
      await this.sessions.notifyEnded();
    } catch (e) {
      this.log.warn(`конец фокуса не разослан: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.busy = false;
    }
  }
}
