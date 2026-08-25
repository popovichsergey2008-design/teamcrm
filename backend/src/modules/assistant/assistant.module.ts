import { Module } from '@nestjs/common';
import { AssistantController } from './assistant.controller';
import { AssistantRepository } from './assistant.repository';
import { AssistantScheduler } from './assistant.scheduler';
import { AssistantService } from './assistant.service';
import { ModeratorRepository } from './moderator.repository';
import { ModeratorScheduler } from './moderator.scheduler';
import { ModeratorService } from './moderator.service';

/**
 * AI Секретарь: смарт-пинги (напоминания о зависшей работе) и модератор встреч
 * (повестка за пять минут до начала).
 *
 * Realtime и журнал действий берутся из глобальных модулей — отдельного импорта
 * не требуют, как и в остальных местах, где пишут в журнал ассистента.
 */
@Module({
  controllers: [AssistantController],
  providers: [
    AssistantService, AssistantRepository, AssistantScheduler,
    ModeratorService, ModeratorRepository, ModeratorScheduler,
  ],
  exports: [AssistantService, ModeratorService],
})
export class AssistantModule {}
