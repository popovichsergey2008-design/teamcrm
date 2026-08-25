import { Module } from '@nestjs/common';
import { AssistantController } from './assistant.controller';
import { AssistantRepository } from './assistant.repository';
import { AssistantScheduler } from './assistant.scheduler';
import { AssistantService } from './assistant.service';

/**
 * AI Секретарь, часть «смарт-пинги»: напоминания о зависшей работе.
 *
 * Realtime и журнал действий берутся из глобальных модулей — отдельного импорта
 * не требуют, как и в остальных местах, где пишут в журнал ассистента.
 */
@Module({
  controllers: [AssistantController],
  providers: [AssistantService, AssistantRepository, AssistantScheduler],
  exports: [AssistantService],
})
export class AssistantModule {}
