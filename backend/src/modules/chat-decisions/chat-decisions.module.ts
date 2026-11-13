import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ChatsModule } from '../chats/chats.module';
import { FeedModule } from '../feed/feed.module';
import { TasksModule } from '../tasks/tasks.module';
import { ChatDecisionsController } from './chat-decisions.controller';
import { ChatDecisionsService } from './chat-decisions.service';

/** #4902, п. 9: вкладка «Решения» чата. */
@Module({
  imports: [AiModule, ChatsModule, FeedModule, TasksModule],
  controllers: [ChatDecisionsController],
  providers: [ChatDecisionsService],
})
export class ChatDecisionsModule {}
