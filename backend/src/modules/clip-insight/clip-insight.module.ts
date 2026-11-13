import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ChatsModule } from '../chats/chats.module';
import { NlModule } from '../nl/nl.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { ClipInsightController } from './clip-insight.controller';
import { ClipInsightService } from './clip-insight.service';

/** #4902, п. 14: видео и голос → текст и задачи. Чаты сообщают о распознанном клипе хуком. */
@Module({
  imports: [AiModule, ChatsModule, NlModule, RealtimeModule],
  controllers: [ClipInsightController],
  providers: [ClipInsightService],
})
export class ClipInsightModule {}
