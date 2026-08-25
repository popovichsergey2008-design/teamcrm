import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ModeratorRepository } from './moderator.repository';
import { ModeratorService } from './moderator.service';

const TICK_MS = 60_000;

/**
 * Окно сбора повестки: встречи, которые начнутся через 4–6 минут.
 *
 * Не точка «ровно за пять»: тик может задержаться, а повестка, пришедшая после
 * начала встречи, бесполезна. Нижняя граница в 4 минуты оставляет время прочитать.
 */
const FROM_MIN = 4;
const TO_MIN = 6;

/**
 * Модератор встреч: повестка за пять минут до начала.
 *
 * Отдельный планировщик, а не общий проход ассистента: пинги ходят раз в 15 минут,
 * этого хватает для просрочек, но не для «за пять минут до встречи».
 */
@Injectable()
export class ModeratorScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('MeetingModerator');
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly repo: ModeratorRepository,
    private readonly moderator: ModeratorService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.(); // не держим процесс в тестах и консольных запусках
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Один проход. Публичный — тесты зовут напрямую, не дожидаясь минуты. */
  async tick(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    let prepared = 0;
    try {
      for (const event of await this.repo.dueEvents(FROM_MIN, TO_MIN)) {
        try {
          if (await this.moderator.prepare(event)) prepared++;
        } catch (e) {
          // одна встреча без повестки не повод бросать остальные
          this.log.warn(`повестка события ${event.id}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      this.log.warn(`проход модератора не удался: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
    return prepared;
  }
}
