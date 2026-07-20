import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { DealsModule } from '../deals/deals.module';
import { NlController } from './nl.controller';
import { NlService } from './nl.service';

/** NL-команда / Zero-UI: естественный язык → создание задачи/сделки (с подтверждением). */
@Module({
  imports: [TasksModule, DealsModule],
  controllers: [NlController],
  providers: [NlService],
  exports: [NlService],
})
export class NlModule {}
