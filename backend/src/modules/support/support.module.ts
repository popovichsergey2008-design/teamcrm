import { Module } from '@nestjs/common';
import { AnthillModule } from '../anthill/anthill.module';
import { AiModule } from '../ai/ai.module';
import { FilesModule } from '../files/files.module';
import { ForecastModule } from '../forecast/forecast.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { MeetingsModule } from '../meetings/meetings.module';
import { ProjectsModule } from '../projects/projects.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { TasksModule } from '../tasks/tasks.module';
import { SupportController } from './support.controller';
import { SupportDeskController } from './support-desk.controller';
import { SupportConciergeController } from './support-concierge.controller';
import { SupportConciergeRepository } from './support-concierge.repository';
import { SupportConciergeService } from './support-concierge.service';
import { SupportDeskRepository } from './support-desk.repository';
import { SupportDeskService } from './support-desk.service';
import { SupportRepository } from './support.repository';
import { SupportService } from './support.service';
import { NotificationsModule } from '../notifications/notifications.module';

/**
 * Служба заботы (ТЗ-8) и старая кнопка «Поддержка».
 *
 * Разговор — новая сущность (SupportDesk*), обращение-задача — прежний путь: он
 * остаётся для случаев, когда из разговора рождается работа для команды.
 */
@Module({
  imports: [
    ProjectsModule, TasksModule, RealtimeModule, FilesModule, AnthillModule, MeetingsModule,
    ForecastModule, KnowledgeModule,
    // Push человеку, который ушёл из приложения, не дождавшись ответа (волна 10).
    NotificationsModule,
    // Записка специалисту о том, что уже пробовали, — короткий вызов модели напрямую.
    AiModule,
  ],
  // консьерж (ТЗ-29) — ПЕРВЫМ: его «support/desk/concierge…» не должен уйти в «support/desk/:id»
  controllers: [SupportConciergeController, SupportController, SupportDeskController],
  providers: [SupportService, SupportRepository, SupportDeskService, SupportDeskRepository, SupportConciergeService, SupportConciergeRepository],
  exports: [SupportDeskService],
})
export class SupportModule {}
