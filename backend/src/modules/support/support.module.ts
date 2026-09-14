import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { TasksModule } from '../tasks/tasks.module';
import { SupportController } from './support.controller';
import { SupportRepository } from './support.repository';
import { SupportService } from './support.service';

@Module({
  imports: [ProjectsModule, TasksModule],
  controllers: [SupportController],
  providers: [SupportService, SupportRepository],
})
export class SupportModule {}
