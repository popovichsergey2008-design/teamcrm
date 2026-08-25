import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { TasksController } from './tasks.controller';
import { HandoffGateController } from './handoff-gate.controller';
import { TasksService } from './tasks.service';
import { TasksRepository } from './tasks.repository';
import { TaskActivityRepository } from './task-activity.repository';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { IntegrationOutboxModule } from '../integrations/outbox/integration-outbox.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [ProjectsModule, KnowledgeModule, IntegrationOutboxModule, NotificationsModule],
  controllers: [TasksController, HandoffGateController],
  providers: [TasksService, TasksRepository, TaskActivityRepository],
  exports: [TasksService, TasksRepository, TaskActivityRepository],
})
export class TasksModule {}
