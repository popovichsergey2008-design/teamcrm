import { Module } from '@nestjs/common';
import { EconomicsModule } from '../economics/economics.module';
import { TimeTrackingController } from './timetracking.controller';
import { TimeTrackingService } from './timetracking.service';
import { TimeTrackingRepository } from './timetracking.repository';

@Module({
  imports: [EconomicsModule],
  controllers: [TimeTrackingController],
  providers: [TimeTrackingService, TimeTrackingRepository],
  exports: [TimeTrackingRepository],
})
export class TimeTrackingModule {}
