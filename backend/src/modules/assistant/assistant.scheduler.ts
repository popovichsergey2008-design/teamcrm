import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AssistantRepository } from './assistant.repository';
import { AssistantService } from './assistant.service';

/**
 * Раз в 15 минут — не чаще: поводы для напоминания меняются часами, а не секундами,
 * и частый проход только жёг бы базу. Ключ повтора всё равно держит один повод
 * в сутки, так что лишние проходы ничего не добавляют.
 */
const TICK_MS = 15 * 60_000;

/**
 * Планировщик смарт-пингов.
 *
 * Ходит по организациям, где ассистент включён, и складывает напоминания: в режиме
 * «автопилот» — сразу людям, в «копилоте» — постановщику на подтверждение.
 * Организации с выключенным ассистентом не опрашиваются вовсе.
 */
@Injectable()
export class AssistantScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('AssistantPings');
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly repo: AssistantRepository,
    private readonly assistant: AssistantService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.(); // не держим процесс в тестах и консольных запусках
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Один проход по всем организациям. Публичный — тесты зовут напрямую. */
  async tick(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    let created = 0;
    try {
      for (const t of await this.repo.activeTenants()) {
        try {
          created += await this.assistant.runTenant(String(t.id), t.assistant_mode);
        } catch (e) {
          // одна организация не должна останавливать остальные
          this.log.warn(`пинги для организации ${t.id}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      this.log.warn(`проход пингов не удался: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
    return created;
  }
}
