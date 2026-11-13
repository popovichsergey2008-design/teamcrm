import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ChatsModule } from '../chats/chats.module';
import { DecisionQueueModule } from '../decision-queue/decision-queue.module';
import { RadarIndexModule } from '../radar/radar-index.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { TaskCardModule } from '../taskcard/taskcard.module';
import { TasksModule } from '../tasks/tasks.module';
import { DecisionRunController } from './decision-run.controller';
import { DecisionRunService } from './decision-run.service';

/** Разбор решений по одной карточке в «Фокусе дня» (#4890, пп. 4–6). */
@Module({
  imports: [DecisionQueueModule, RadarIndexModule, TasksModule, TaskCardModule, ChatsModule, AiModule, RealtimeModule],
  controllers: [DecisionRunController],
  providers: [DecisionRunService],
})
export class DecisionRunModule {}
