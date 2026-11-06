import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ProjectsModule } from '../projects/projects.module';
import { TaskCardModule } from '../taskcard/taskcard.module';
import { TasksModule } from '../tasks/tasks.module';
import { FlowController, ShareController } from './flow.controller';
import { FlowRepository } from './flow.repository';
import { FlowService } from './flow.service';

/** Поток работы на доске (#4798 / #4799). */
@Module({
  imports: [TasksModule, TaskCardModule, NotificationsModule, ProjectsModule, FilesModule],
  controllers: [FlowController, ShareController],
  providers: [FlowRepository, FlowService],
  exports: [FlowRepository],
})
export class FlowModule {}
