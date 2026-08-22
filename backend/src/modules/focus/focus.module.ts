import { Module } from '@nestjs/common';
import { FocusController } from './focus.controller';
import { FocusService } from './focus.service';

@Module({
  controllers: [FocusController],
  providers: [FocusService],
  exports: [FocusService], // таймер ставит фокус сам, когда задачу берут в работу
})
export class FocusModule {}
