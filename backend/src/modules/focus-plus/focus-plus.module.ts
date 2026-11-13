import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { CalendarModule } from '../calendar/calendar.module';
import { CalendarPlusModule } from '../calendar-plus/calendar-plus.module';
import { FocusModule } from '../focus/focus.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TasksModule } from '../tasks/tasks.module';
import { FocusPlusController } from './focus-plus.controller';
import { FocusPlusService } from './focus-plus.service';
import { FocusPlusScheduler } from './focus-plus.scheduler';
import { FocusWave2Service } from './focus-wave2.service';

/** #4891 ТЗ «Фокус дня»: утро → день → вечер поверх существующего плана дня. */
@Module({
  imports: [FocusModule, CalendarModule, CalendarPlusModule, AiModule, TasksModule, NotificationsModule],
  controllers: [FocusPlusController],
  providers: [FocusPlusService, FocusWave2Service, FocusPlusScheduler],
  exports: [FocusPlusService, FocusWave2Service],
})
export class FocusPlusModule {}
