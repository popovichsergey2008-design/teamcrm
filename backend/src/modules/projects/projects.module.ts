import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { ProjectsRepository } from './projects.repository';
import { IntegrationOutboxModule } from '../integrations/outbox/integration-outbox.module';
import { TaskReadsModule } from '../tasks/task-reads.module';

@Module({
  imports: [IntegrationOutboxModule, TaskReadsModule],
  controllers: [ProjectsController],
  providers: [ProjectsService, ProjectsRepository],
  exports: [ProjectsService, ProjectsRepository],
})
export class ProjectsModule {}
