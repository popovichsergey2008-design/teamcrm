import { Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { CalendarModule } from '../calendar/calendar.module';
import { IntegrationCryptoService } from '../integrations/crypto.service';
import { GoogleAuthService } from './google-auth.service';
import { GoogleCalendarService } from './google-calendar.service';
import { GoogleController } from './google.controller';
import { GoogleDriveService } from './google-drive.service';

/** Раз в минуту смотрим, чей Google пора перечитать (сам календарь — раз в 10 минут). */
const TICK_MS = 60_000;

@Injectable()
class GoogleScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('GoogleSync');
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(private readonly calendar: GoogleCalendarService) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.calendar.tick();
    } catch (e) {
      this.log.warn(`проход не удался: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}

/**
 * #1565 Google Workspace — Диск, Документы, Календарь по OAuth человека.
 * Не путать с модулем gdocs: тот без OAuth читает публичные Google-документы в базу знаний.
 */
@Module({
  imports: [CalendarModule],
  controllers: [GoogleController],
  providers: [GoogleAuthService, GoogleDriveService, GoogleCalendarService, GoogleScheduler, IntegrationCryptoService],
})
export class GoogleModule {}
