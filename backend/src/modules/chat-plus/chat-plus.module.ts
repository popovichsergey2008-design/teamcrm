import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ChatsModule } from '../chats/chats.module';
import { ChatPlusController } from './chat-plus.controller';
import { ChatPlusService } from './chat-plus.service';

@Module({
  imports: [AiModule, ChatsModule],
  controllers: [ChatPlusController],
  providers: [ChatPlusService],
})
export class ChatPlusModule {}
