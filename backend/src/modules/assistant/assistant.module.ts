import { Module } from '@nestjs/common';
import { MeetingsModule } from '../meetings/meetings.module';
import { ProjectsModule } from '../projects/projects.module';
import { TasksModule } from '../tasks/tasks.module';
import { AssistantController } from './assistant.controller';
import { AssistantRepository } from './assistant.repository';
import { AssistantScheduler } from './assistant.scheduler';
import { AssistantService } from './assistant.service';
import { ModeratorRepository } from './moderator.repository';
import { ModeratorScheduler } from './moderator.scheduler';
import { ModeratorService } from './moderator.service';
import { MaintenanceRepository } from './maintenance.repository';
import { MaintenanceScheduler } from './maintenance.scheduler';
import { MaintenanceService } from './maintenance.service';

/**
 * AI Секретарь: смарт-пинги (напоминания о зависшей работе), модератор встреч
 * (повестка за пять минут до начала) и уборка брошенного (Zero-Maintenance).
 *
 * Realtime и журнал действий берутся из глобальных модулей — отдельного импорта
 * не требуют, как и в остальных местах, где пишут в журнал ассистента.
 */
@Module({
  // уборка ходит теми же путями, что и человек: перенос задачи, архивация проекта,
  // отклонение черновика — поэтому берёт готовые сервисы, а не пишет в базу сама
  imports: [TasksModule, ProjectsModule, MeetingsModule],
  controllers: [AssistantController],
  providers: [
    AssistantService, AssistantRepository, AssistantScheduler,
    ModeratorService, ModeratorRepository, ModeratorScheduler,
    MaintenanceService, MaintenanceRepository, MaintenanceScheduler,
  ],
  exports: [AssistantService, ModeratorService, MaintenanceService],
})
export class AssistantModule {}
