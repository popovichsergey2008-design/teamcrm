import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { TaskCardController } from './taskcard.controller';
import { LabelsController } from './labels.controller';
import { TaskCardService } from './taskcard.service';
import { TaskCardRepository } from './taskcard.repository';
import { IntegrationOutboxModule } from '../integrations/outbox/integration-outbox.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';

@Module({
  imports: [TasksModule, IntegrationOutboxModule, NotificationsModule, KnowledgeModule],
  controllers: [TaskCardController, LabelsController],
  providers: [TaskCardService, TaskCardRepository],
  exports: [TaskCardRepository, TaskCardService],
})
export class TaskCardModule {}
