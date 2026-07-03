import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { TasksRepository } from './tasks.repository';
import { TaskActivityRepository } from './task-activity.repository';
import { KnowledgeModule } from '../knowledge/knowledge.module';

@Module({
  imports: [ProjectsModule, KnowledgeModule],
  controllers: [TasksController],
  providers: [TasksService, TasksRepository, TaskActivityRepository],
  exports: [TasksService, TasksRepository, TaskActivityRepository],
})
export class TasksModule {}
