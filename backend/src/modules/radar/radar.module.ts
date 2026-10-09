import { Module } from '@nestjs/common';
import { RadarController } from './radar.controller';
import { RadarService } from './radar.service';
import { RadarRepository } from './radar.repository';
import { PulseRepository } from './pulse.repository';
import { PulseService } from './pulse.service';
import { TasksModule } from '../tasks/tasks.module';
import { ForecastModule } from '../forecast/forecast.module';
import { CalendarModule } from '../calendar/calendar.module';
import { FeedModule } from '../feed/feed.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RealtimeModule } from '../realtime/realtime.module';

/** «Пульс команды»: прежняя сводка (/radar — её читают выпущенные приложения) и командный центр (ТЗ-19). */
@Module({
  imports: [TasksModule, ForecastModule, CalendarModule, FeedModule, NotificationsModule, RealtimeModule],
  controllers: [RadarController],
  providers: [RadarService, RadarRepository, PulseRepository, PulseService],
  exports: [PulseService],
})
export class RadarModule {}
