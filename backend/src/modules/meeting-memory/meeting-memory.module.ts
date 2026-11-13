import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { MeetingMemoryController } from './meeting-memory.controller';
import { MeetingMemoryService } from './meeting-memory.service';

/**
 * #4902, п. 12: встреча помнит прошлую и пересказывает опоздавшим. Служба отдаётся
 * наружу сокету созвонов (MediaModule): «Кратко до сих пор» читает идущую запись.
 */
@Module({
  imports: [AiModule],
  controllers: [MeetingMemoryController],
  providers: [MeetingMemoryService],
  exports: [MeetingMemoryService],
})
export class MeetingMemoryModule {}
