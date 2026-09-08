import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { TasksController } from './tasks.controller';
import { HandoffGateController } from './handoff-gate.controller';
import { TasksService } from './tasks.service';
import { TasksRepository } from './tasks.repository';
import { TaskActivityRepository } from './task-activity.repository';
import { TaskMergeService } from './task-merge.service';
import { TaskMergeRepository } from './task-merge.repository';
import { TaskRecurrenceRepository } from './task-recurrence.repository';
import { RecurrenceScheduler } from './recurrence.scheduler';
import { TaskReadsModule } from './task-reads.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { IntegrationOutboxModule } from '../integrations/outbox/integration-outbox.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [ProjectsModule, KnowledgeModule, IntegrationOutboxModule, NotificationsModule, TaskReadsModule],
  controllers: [TasksController, HandoffGateController],
  providers: [
    TasksService, TasksRepository, TaskActivityRepository, TaskRecurrenceRepository, RecurrenceScheduler,
    TaskMergeService, TaskMergeRepository,
  ],
  exports: [TasksService, TasksRepository, TaskActivityRepository, TaskRecurrenceRepository, TaskReadsModule],
})
export class TasksModule {}
