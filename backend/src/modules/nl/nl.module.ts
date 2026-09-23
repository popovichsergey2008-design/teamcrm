import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { DealsModule } from '../deals/deals.module';
import { NlController } from './nl.controller';
import { NlService } from './nl.service';
import { VoiceRepository } from './voice.repository';
import { VoiceService } from './voice.service';
import { FilesModule } from '../files/files.module';
import { UsersModule } from '../users/users.module';
import { BatchRepository } from './batch.repository';
import { BatchService } from './batch.service';

/** NL-команда / Zero-UI: естественный язык → создание задачи/сделки (с подтверждением). */
@Module({
  // FilesModule — чтобы сохранить надиктовку до обработки: аудио должно пережить
  // любую ошибку разбора, иначе человек диктует десять минут заново
  // UsersModule — кандидаты для автоподбора исполнителя (ТЗ-10, этап 4).
  imports: [TasksModule, DealsModule, FilesModule, UsersModule],
  controllers: [NlController],
  providers: [NlService, VoiceService, VoiceRepository, BatchService, BatchRepository],
  exports: [NlService],
})
export class NlModule {}
