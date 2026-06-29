import { Module } from '@nestjs/common';
import { TelegramModule } from '../telegram/telegram.module';
import { TasksModule } from '../tasks/tasks.module';
import { ProjectsModule } from '../projects/projects.module';
import { TimeTrackingModule } from '../timetracking/timetracking.module';
import { EconomicsModule } from '../economics/economics.module';
import { StandupController } from './standup.controller';
import { StandupService } from './standup.service';
import { StandupRepository } from './standup.repository';
import { StandupConsumer } from './standup.consumer';

@Module({
  imports: [TelegramModule, TasksModule, ProjectsModule, TimeTrackingModule, EconomicsModule],
  controllers: [StandupController],
  providers: [StandupService, StandupRepository, StandupConsumer],
})
export class StandupModule {}
