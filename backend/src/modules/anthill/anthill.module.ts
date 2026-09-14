import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { TasksModule } from '../tasks/tasks.module';
import { ChatsModule } from '../chats/chats.module';
import { SearchModule } from '../search/search.module';
import { NlModule } from '../nl/nl.module';
import { AssistantModule } from '../assistant/assistant.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { FilesModule } from '../files/files.module';
import { TaskCardModule } from '../taskcard/taskcard.module';
import { AnthillController } from './anthill.controller';
import { AnthillRepository } from './anthill.repository';
import { AnthillService } from './anthill.service';
import { AnthillScheduler } from './anthill.scheduler';

/**
 * AnthillBot — оркестратор над существующими модулями: задачи, чаты, поиск,
 * постановка задач словами, вопросы о делах. Своих данных CRM не заводит.
 */
@Module({
  imports: [AiModule, TasksModule, ChatsModule, SearchModule, NlModule, AssistantModule, RealtimeModule, FilesModule, TaskCardModule],
  controllers: [AnthillController],
  providers: [AnthillService, AnthillRepository, AnthillScheduler],
  exports: [AnthillService],
})
export class AnthillModule {}
