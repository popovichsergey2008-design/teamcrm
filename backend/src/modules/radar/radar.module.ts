import { Module } from '@nestjs/common';
import { RadarController } from './radar.controller';
import { RadarService } from './radar.service';
import { RadarRepository } from './radar.repository';

@Module({
  controllers: [RadarController],
  providers: [RadarService, RadarRepository],
})
export class RadarModule {}
