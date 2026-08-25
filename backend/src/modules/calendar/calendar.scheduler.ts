import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RealtimeService } from '../realtime/realtime.service';
import { CalendarMailService } from './calendar-mail.service';
import { CalendarRepository } from './calendar.repository';

const TICK_MS = 60_000;

/**
 * Напоминания о встречах.
 *
 * Раз в минуту забирает те напоминания, которым пора уйти, и шлёт их двумя путями:
 * письмом и сообщением в открытое приложение. Двумя намеренно — письмо доходит, когда
 * человека нет за экраном, а всплывающее напоминание работает, когда он за экраном,
 * но письма не читает.
 *
 * Отправленное записывается в журнал вместе со временем НАЧАЛА события: встречу
 * перенесли — напомним заново, потому что напоминание о старом времени бесполезно.
 */
@Injectable()
export class CalendarScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('CalendarReminders');
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly repo: CalendarRepository,
    private readonly mail: CalendarMailService,
    private readonly realtime: RealtimeService,
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
    let sent = 0;
    try {
      for (const r of await this.repo.dueReminders()) {
        try {
          await this.mail.sendReminder(r);
          this.realtime.emitToUsers(String(r.tenant_id), [String(r.user_id)], 'calendar.reminder', {
            eventId: String(r.event_id),
            title: r.title,
            startsAt: r.starts_at,
            minutesBefore: r.minutes_before,
            location: r.location,
          });
          await this.repo.markReminderSent(r.event_id, r.user_id, r.minutes_before, r.starts_at);
          sent++;
        } catch (e) {
          // одно неудачное напоминание не должно останавливать остальные
          this.log.warn(`напоминание по событию ${r.event_id}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      this.log.warn(`проход напоминаний не удался: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
    return sent;
  }
}
