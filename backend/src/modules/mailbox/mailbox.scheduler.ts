import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MailboxService } from './mailbox.service';

/** Раз в минуту смотрим, чьи ящики пора забрать (сам ящик — раз в 5 минут). */
const TICK_MS = 60_000;

@Injectable()
export class MailboxScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('MailboxSync');
  private timer?: NodeJS.Timeout;
  private busy = false;
  private lastPrune = 0;

  constructor(private readonly mail: MailboxService) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.mail.tick();
      if (Date.now() - this.lastPrune > 6 * 3600_000) {
        this.lastPrune = Date.now();
        await this.mail.prune();
      }
    } catch (e) {
      this.log.warn(`проход не удался: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}
