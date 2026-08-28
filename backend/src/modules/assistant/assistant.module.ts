import { Module } from '@nestjs/common';
import { ForecastModule } from '../forecast/forecast.module';
import { MeetingsModule } from '../meetings/meetings.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ProjectsModule } from '../projects/projects.module';
import { TasksModule } from '../tasks/tasks.module';
import { AssistantController } from './assistant.controller';
import { AssistantRepository } from './assistant.repository';
import { AssistantScheduler } from './assistant.scheduler';
import { AssistantService } from './assistant.service';
import { ModeratorRepository } from './moderator.repository';
import { ModeratorScheduler } from './moderator.scheduler';
import { ModeratorService } from './moderator.service';
import { GapsRepository } from './gaps.repository';
import { GapsService } from './gaps.service';
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
  // NotificationsModule — ради канала в Telegram: сводка приходит туда же, куда
  // остальные уведомления, и слушается той же настройки человека
  // ForecastModule — чтобы секретарь назначал исполнителя тем же путём, что и человек:
  // с предупреждением о перегрузе, а не прямым UPDATE в обход правил
  imports: [TasksModule, ProjectsModule, MeetingsModule, NotificationsModule, ForecastModule],
  controllers: [AssistantController],
  providers: [
    AssistantService, AssistantRepository, AssistantScheduler,
    ModeratorService, ModeratorRepository, ModeratorScheduler,
    MaintenanceService, MaintenanceRepository, MaintenanceScheduler,
    GapsService, GapsRepository,
  ],
  exports: [AssistantService, ModeratorService, MaintenanceService, GapsService],
})
export class AssistantModule {}
