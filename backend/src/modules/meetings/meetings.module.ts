import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { TasksModule } from '../tasks/tasks.module';
import { TaskCardModule } from '../taskcard/taskcard.module';
import { MeetingsController } from './meetings.controller';
import { MeetingsRepository } from './meetings.repository';
import { MeetingsService } from './meetings.service';

/** Этап 6, М2: разбор записей встреч. Свои созвоны появятся позже — источник записи внешний. */
@Module({
  imports: [AiModule, TasksModule, KnowledgeModule, TaskCardModule],
  controllers: [MeetingsController],
  providers: [MeetingsService, MeetingsRepository],
  exports: [MeetingsService, MeetingsRepository], // репозиторий нужен уборке: черновики со встреч
})
export class MeetingsModule {}
