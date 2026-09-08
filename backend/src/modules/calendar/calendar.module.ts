import { Module } from '@nestjs/common';
import { CalendarController } from './calendar.controller';
import { CalendarMailService } from './calendar-mail.service';
import { CalendarRepository } from './calendar.repository';
import { CalendarScheduler } from './calendar.scheduler';
import { CalendarService } from './calendar.service';
import { CalendarSyncService } from './calendar-sync.service';
import { IntegrationCryptoService } from '../integrations/crypto.service';

/**
 * ТЗ-2, этап 6, шаг 1 — календарь: личные события и события компании.
 * Напоминания, занятость коллег и повторы — следующие шаги (см. specs/tz2-06-calendar-step1.md).
 */
@Module({
  controllers: [CalendarController],
  providers: [
    CalendarService, CalendarRepository, CalendarMailService, CalendarScheduler,
    CalendarSyncService, IntegrationCryptoService,
  ],
  exports: [CalendarService, CalendarRepository], // репозиторий нужен счётчикам панели
})
export class CalendarModule {}
