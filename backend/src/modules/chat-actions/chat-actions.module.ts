import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ChatsModule } from '../chats/chats.module';
import { NlModule } from '../nl/nl.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { ChatActionsController } from './chat-actions.controller';
import { ChatActionsService } from './chat-actions.service';

/** Действия с сообщением чата (#4902, пп. 7–8). */
@Module({
  imports: [AiModule, ChatsModule, NlModule, RealtimeModule],
  controllers: [ChatActionsController],
  providers: [ChatActionsService],
})
export class ChatActionsModule {}
