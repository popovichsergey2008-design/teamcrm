import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MaintenanceRepository } from './maintenance.repository';
import { MaintenanceService } from './maintenance.service';

/**
 * Раз в шесть часов — и этого много.
 *
 * Речь о задачах, брошенных два месяца назад: за час ничего не изменится. Реже смысла
 * тоже нет — предложение должно появиться в тот же день, когда объект «дозрел», иначе
 * человек увидит его случайно и не поймёт, почему сейчас.
 */
const TICK_MS = 6 * 60 * 60_000;

/** Первый проход — через минуту после старта, чтобы не грузить запуск приложения. */
const FIRST_RUN_MS = 60_000;

@Injectable()
export class MaintenanceScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Maintenance');
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly repo: MaintenanceRepository,
    private readonly maintenance: MaintenanceService,
  ) {}

  onModuleInit(): void {
    this.first = setTimeout(() => void this.tick(), FIRST_RUN_MS);
    this.first.unref?.();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.(); // не держим процесс в тестах и консольных запусках
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
  }

  /** Один проход по организациям, где уборка включена. Публичный — тесты зовут напрямую. */
  async tick(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    let created = 0;
    try {
      for (const t of await this.repo.activeTenants()) {
        try {
          created += await this.maintenance.runTenant(String(t.id));
        } catch (e) {
          // одна организация не должна останавливать остальные
          this.log.warn(`уборка в организации ${t.id}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      this.log.warn(`проход уборки не удался: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
    return created;
  }
}
