import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ClientsModule } from '../clients/clients.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TasksModule } from '../tasks/tasks.module';
import { TaskCardModule } from '../taskcard/taskcard.module';
import { MeetingsController } from './meetings.controller';
import { MeetingsRepository } from './meetings.repository';
import { MeetingsService } from './meetings.service';
import { PostcallRepository } from './postcall.repository';
import { PostcallService } from './postcall.service';

/** Этап 6, М2: разбор записей встреч. Свои созвоны появятся позже — источник записи внешний. */
@Module({
  imports: [AiModule, TasksModule, KnowledgeModule, TaskCardModule, NotificationsModule, ClientsModule],
  controllers: [MeetingsController],
  providers: [MeetingsService, MeetingsRepository, PostcallService, PostcallRepository],
  exports: [MeetingsService, MeetingsRepository, PostcallService], // репозиторий нужен уборке: черновики со встреч
})
export class MeetingsModule {}
