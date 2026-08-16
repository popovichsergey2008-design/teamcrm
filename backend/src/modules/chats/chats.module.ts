import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { ChatsController } from './chats.controller';
import { ChatsRepository } from './chats.repository';
import { ChatsService } from './chats.service';

/** Этап 6, М1 — мессенджер команды: личные диалоги, группы, чаты проектов. */
@Module({
  imports: [RealtimeModule],
  controllers: [ChatsController],
  providers: [ChatsService, ChatsRepository],
  exports: [ChatsService],
})
export class ChatsModule {}
