import { NlModule } from '../nl/nl.module';
import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ClientsModule } from '../clients/clients.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PromptsModule } from '../prompts/prompts.module';
import { TasksModule } from '../tasks/tasks.module';
import { TaskCardModule } from '../taskcard/taskcard.module';
import { MeetingsController } from './meetings.controller';
import { MeetingsRepository } from './meetings.repository';
import { MeetingsService } from './meetings.service';
import { PostcallRepository } from './postcall.repository';
import { AudioProofController } from './audio-proof.controller';
import { AudioProofService } from './audio-proof.service';
import { PostcallService } from './postcall.service';

/** Этап 6, М2: разбор записей встреч. Свои созвоны появятся позже — источник записи внешний. */
@Module({
  imports: [AiModule, TasksModule, KnowledgeModule, TaskCardModule, NotificationsModule, ClientsModule, PromptsModule, NlModule],
  controllers: [MeetingsController, AudioProofController],
  providers: [MeetingsService, MeetingsRepository, PostcallService, PostcallRepository, AudioProofService],
  exports: [MeetingsService, MeetingsRepository, PostcallService], // репозиторий нужен уборке: черновики со встреч
})
export class MeetingsModule {}
