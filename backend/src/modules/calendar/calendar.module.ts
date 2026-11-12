import { Module } from '@nestjs/common';
import { CalendarController } from './calendar.controller';
import { CalendarBlocksController } from './calendar-blocks.controller';
import { CalendarBlocksRepository } from './calendar-blocks.repository';
import { CalendarBlocksService } from './calendar-blocks.service';
import { CalendarCardService } from './calendar-card.service';
import { CalendarSeriesService } from './calendar-series.service';
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
  controllers: [CalendarController, CalendarBlocksController],
  providers: [
    CalendarService, CalendarRepository, CalendarMailService, CalendarScheduler,
    CalendarSyncService, IntegrationCryptoService,
    // #4787: время на задачи и запланированный фокус
    CalendarBlocksService, CalendarBlocksRepository, CalendarCardService, CalendarSeriesService,
  ],
  // репозиторий нужен счётчикам панели; почта — приглашениям гостей встреч (ТЗ-14)
  exports: [CalendarService, CalendarRepository, CalendarMailService, CalendarBlocksService, CalendarCardService, CalendarSeriesService, CalendarBlocksRepository, CalendarSyncService],
})
export class CalendarModule {}
