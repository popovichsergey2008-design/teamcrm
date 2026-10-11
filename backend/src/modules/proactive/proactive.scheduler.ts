import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ProactiveService } from './proactive.service';

/** Каждые 2 минуты: вернуть отложенное, закрыть неактуальное. Навыки ставят свои таймеры сами. */
const TICK_MS = 2 * 60_000;

@Injectable()
export class ProactiveScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('ProactiveScheduler');
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private readonly jobs: { name: string; run: () => Promise<void> }[] = [];

  constructor(private readonly svc: ProactiveService) {}

  /** Навык добавляет свой проход (проверка обещаний, утренний бриф) — один таймер на всех. */
  add(name: string, run: () => Promise<void>): void {
    this.jobs.push({ name, run });
  }

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    this.timer.unref?.();
    setTimeout(() => { void this.tick(); }, 45_000).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.svc.sweep().catch((e) => this.log.warn(`ящик: ${(e as Error).message}`));
      for (const j of this.jobs) {
        await j.run().catch((e) => this.log.warn(`${j.name}: ${(e as Error).message}`));
      }
    } finally {
      this.busy = false;
    }
  }
}
