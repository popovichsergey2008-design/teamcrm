import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { CalendarModule } from '../calendar/calendar.module';
import { CalendarPlusModule } from '../calendar-plus/calendar-plus.module';
import { FocusModule } from '../focus/focus.module';
import { FocusPlusController } from './focus-plus.controller';
import { FocusPlusService } from './focus-plus.service';

/** #4891 ТЗ «Фокус дня»: утро → день → вечер поверх существующего плана дня. */
@Module({
  imports: [FocusModule, CalendarModule, CalendarPlusModule, AiModule],
  controllers: [FocusPlusController],
  providers: [FocusPlusService],
  exports: [FocusPlusService],
})
export class FocusPlusModule {}
