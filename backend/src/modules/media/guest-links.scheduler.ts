import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { GuestLinksService } from './guest-links.service';

const TICK_MS = 60_000;

/**
 * Напоминание открыть комнату перед встречей с гостем.
 *
 * Ссылку отправили вчера на «завтра в 9» — к девяти о ней помнит только гость. А
 * впустить его может лишь сотрудник, сидящий в комнате. Поэтому за несколько минут до
 * начала автору ссылки (и сотрудникам события) приходит «откройте комнату».
 */
@Injectable()
export class GuestLinksScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('GuestLinksReminders');
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(private readonly guests: GuestLinksService) {}

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
    try {
      const hosts = await this.guests.remindDue();
      // гостям по email — напоминание за 15 минут по их же ссылке
      const guests = await this.guests.remindGuests().catch(() => 0);
      return hosts + guests;
    } catch (e) {
      this.log.warn(`проход напоминаний о гостевых встречах не удался: ${(e as Error).message}`);
      return 0;
    } finally {
      this.busy = false;
    }
  }
}
