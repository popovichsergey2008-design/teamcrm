import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { TaskCardController } from './taskcard.controller';
import { LabelsController } from './labels.controller';
import { TaskCardService } from './taskcard.service';
import { TaskCardRepository } from './taskcard.repository';

@Module({
  imports: [TasksModule],
  controllers: [TaskCardController, LabelsController],
  providers: [TaskCardService, TaskCardRepository],
  exports: [TaskCardRepository],
})
export class TaskCardModule {}
