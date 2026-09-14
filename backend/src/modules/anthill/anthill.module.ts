import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { TasksModule } from '../tasks/tasks.module';
import { ChatsModule } from '../chats/chats.module';
import { SearchModule } from '../search/search.module';
import { NlModule } from '../nl/nl.module';
import { AssistantModule } from '../assistant/assistant.module';
import { AnthillController } from './anthill.controller';
import { AnthillRepository } from './anthill.repository';
import { AnthillService } from './anthill.service';

/**
 * AnthillBot — оркестратор над существующими модулями: задачи, чаты, поиск,
 * постановка задач словами, вопросы о делах. Своих данных CRM не заводит.
 */
@Module({
  imports: [AiModule, TasksModule, ChatsModule, SearchModule, NlModule, AssistantModule],
  controllers: [AnthillController],
  providers: [AnthillService, AnthillRepository],
  exports: [AnthillService],
})
export class AnthillModule {}
