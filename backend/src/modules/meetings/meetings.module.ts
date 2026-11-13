import { NlModule } from '../nl/nl.module';
import { Module } from '@nestjs/common';
import { TagsModule } from '../tags/tags.module';
import { CalendarModule } from '../calendar/calendar.module';
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
import { ChatsModule } from '../chats/chats.module';
import { MeetingRecapController } from './meeting-recap.controller';
import { MeetingRecapRepository } from './meeting-recap.repository';
import { MeetingRecapService } from './meeting-recap.service';

/** Этап 6, М2: разбор записей встреч. Свои созвоны появятся позже — источник записи внешний. */
@Module({
  // календарь — #4749: договорённость о следующей встрече агент ставит туда сам
  imports: [AiModule, TasksModule, KnowledgeModule, TaskCardModule, NotificationsModule, ClientsModule, PromptsModule, NlModule, TagsModule, CalendarModule,
    // #4902: личные списки задач со встречи — в «Заметки» участника (ensureSelfChat)
    ChatsModule],
  controllers: [MeetingsController, AudioProofController, MeetingRecapController],
  providers: [MeetingsService, MeetingsRepository, PostcallService, PostcallRepository, AudioProofService,
    MeetingRecapService, MeetingRecapRepository],
  exports: [MeetingsService, MeetingsRepository, PostcallService], // репозиторий нужен уборке: черновики со встреч
})
export class MeetingsModule {}
