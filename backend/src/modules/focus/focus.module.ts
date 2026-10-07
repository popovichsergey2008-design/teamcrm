import { Module } from '@nestjs/common';
import { FocusController } from './focus.controller';
import { FocusService } from './focus.service';
import { FocusDayController } from './focus-day.controller';
import { FocusDayRepository } from './focus-day.repository';
import { FocusDayService } from './focus-day.service';
import { FocusSessionController } from './focus-session.controller';
import { FocusSessionService } from './focus-session.service';

@Module({
  // FocusDayController объявлен ПЕРВЫМ: его путь `focus/today` не должен уйти в чужие маршруты
  controllers: [FocusDayController, FocusSessionController, FocusController],
  providers: [FocusService, FocusDayService, FocusDayRepository, FocusSessionService],
  exports: [FocusService, FocusDayService], // таймер ставит фокус сам, когда задачу берут в работу
})
export class FocusModule {}
