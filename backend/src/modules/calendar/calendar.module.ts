import { Module } from '@nestjs/common';
import { CalendarController } from './calendar.controller';
import { CalendarMailService } from './calendar-mail.service';
import { CalendarRepository } from './calendar.repository';
import { CalendarScheduler } from './calendar.scheduler';
import { CalendarService } from './calendar.service';

/**
 * ТЗ-2, этап 6, шаг 1 — календарь: личные события и события компании.
 * Напоминания, занятость коллег и повторы — следующие шаги (см. specs/tz2-06-calendar-step1.md).
 */
@Module({
  controllers: [CalendarController],
  providers: [CalendarService, CalendarRepository, CalendarMailService, CalendarScheduler],
  exports: [CalendarService, CalendarRepository], // репозиторий нужен счётчикам панели
})
export class CalendarModule {}
