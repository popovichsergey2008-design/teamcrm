import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EconomicsProducer } from './economics.producer';
import { EconomicsRepository } from './economics.repository';

/**
 * Догоняющий тик (Шаг 2.2): раз в ~минуту ставит в очередь пересчёт задач
 * с открытым таймером — стоимость текущей работы растёт визуально в реальном времени.
 */
@Injectable()
export class EconomicsScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('EconomicsTick');
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;

  constructor(
    config: ConfigService,
    private readonly repo: EconomicsRepository,
    private readonly producer: EconomicsProducer,
  ) {
    this.intervalMs = Number(config.get('ECONOMICS_TICK_MS') ?? 60_000);
  }

  onModuleInit() {
    if (this.intervalMs <= 0) return; // отключаемо (тесты)
    this.timer = setInterval(() => this.tick().catch(() => undefined), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  async tick() {
    const open = await this.repo.tasksWithOpenTimers();
    for (const { tenant_id, task_id } of open) {
      await this.producer.enqueue({
        kind: 'recompute_task',
        tenantId: tenant_id,
        taskId: task_id,
        reason: 'scheduled_tick',
        dedupKey: `task:${task_id}`,
      });
    }
    if (open.length) this.logger.debug(`tick: queued ${open.length} open-timer task(s)`);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}
