import { Module } from '@nestjs/common';
import { FocusModule } from '../focus/focus.module';
import { TasksModule } from '../tasks/tasks.module';
import { ProjectsModule } from '../projects/projects.module';
import { FocusBriefController } from './focus-brief.controller';
import { FocusBriefRepository } from './focus-brief.repository';
import { FocusBriefScheduler } from './focus-brief.scheduler';
import { FocusBriefService } from './focus-brief.service';
import { StandupService } from './standup.service';

/**
 * Персональный брифинг «Фокуса дня» (ТЗ-27). Отдельным модулем: ему нужны задачи,
 * ИИ и файлы, а «Фокус дня» нужен им самим — к экрану он подключается сам (attachBrief).
 */
@Module({
  imports: [FocusModule, TasksModule, ProjectsModule],
  controllers: [FocusBriefController],
  providers: [FocusBriefService, FocusBriefRepository, FocusBriefScheduler, StandupService],
  exports: [FocusBriefService, StandupService],
})
export class FocusBriefModule {}
